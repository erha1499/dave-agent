import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { merchantSourceKey } from "./after-sales.ts";
import type { QQIdentity } from "./coupon-store.ts";

export type SupportContextValue = { version: 1;
  focus?: { orderId: string; requestId: string; source: "explicit" | "selection"; selectedAt: number; expiresAt: number };
  requiresRestatement: boolean };
export type SupportContextSnapshot = { revision: number; customerId?: string; bindingId?: string; value?: SupportContextValue };
export type SupportContextPort = {
  read(): Promise<SupportContextSnapshot>;
  write(expected: SupportContextSnapshot, value: SupportContextValue): Promise<SupportContextSnapshot>;
};
export class ConversationStateError extends Error {}
const unavailable = "会话定位暂时不可用，请明确订单号后重试。";
const invalid = "会话定位记录无效，请重新明确订单号。";
const conflict = "会话定位或客户绑定已变更，请重新读取后操作。";
const ttlMs = 15 * 60_000;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every(key => typeof key === "string" && [...required, ...optional].includes(key));
function rejectUnless(condition: unknown, message = invalid): asserts condition {
  if (!condition) throw new ConversationStateError(message);
}

// This value is a locator, never a cached authorization, approval or monetary fact.
function contextValue(input: unknown, now: number, allowExpired: boolean): SupportContextValue {
  rejectUnless(plain(input) && keys(input, ["version", "requiresRestatement"], ["focus"])
    && input.version === 1 && typeof input.requiresRestatement === "boolean");
  if (input.focus === undefined) return { version: 1, requiresRestatement: input.requiresRestatement };
  const focus = input.focus;
  rejectUnless(plain(focus) && keys(focus, ["orderId", "requestId", "source", "selectedAt", "expiresAt"]));
  rejectUnless(typeof focus.orderId === "string" && /^COUPON-\d{4}$/.test(focus.orderId)
    && typeof focus.requestId === "string" && focus.requestId.length > 0 && focus.requestId.length <= 512
    && focus.requestId === focus.requestId.trim() && !/[\u0000-\u001f\u007f]/u.test(focus.requestId)
    && (focus.source === "explicit" || focus.source === "selection"));
  rejectUnless(typeof focus.selectedAt === "number" && Number.isSafeInteger(focus.selectedAt) && focus.selectedAt > 0 && focus.selectedAt <= now
    && typeof focus.expiresAt === "number" && Number.isSafeInteger(focus.expiresAt) && focus.expiresAt <= 8.64e15
    && focus.expiresAt > focus.selectedAt && focus.expiresAt - focus.selectedAt <= ttlMs
    && (allowExpired || focus.expiresAt > now));
  if (focus.expiresAt <= now) return { version: 1, requiresRestatement: true };
  return { version: 1, requiresRestatement: input.requiresRestatement, focus: { orderId: focus.orderId,
    requestId: focus.requestId, source: focus.source, selectedAt: focus.selectedAt, expiresAt: focus.expiresAt } };
}
function storedValue(input: unknown): SupportContextValue {
  try { return contextValue(typeof input === "string" ? JSON.parse(input) : input, Date.now(), true); }
  catch { return { version: 1, requiresRestatement: true }; }
}
function revision(value: unknown) {
  rejectUnless(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
}
function bindingId(value: unknown) {
  rejectUnless(typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n);
  return value;
}

export class ConversationStateStore {
  private pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async controlled<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { if (error instanceof ConversationStateError) throw error; throw new ConversationStateError(unavailable); }
  }
  async ping() { await this.controlled(async () => { await this.pool.query("SELECT source_key FROM conversation_state LIMIT 0"); }); }
  async close() { await this.controlled(() => this.pool.end()); }

  bind(identity: QQIdentity, groupOpenid: string): SupportContextPort {
    rejectUnless(typeof identity?.appId === "string" && typeof identity.senderId === "string" && typeof groupOpenid === "string");
    let sourceKey: string;
    try { sourceKey = merchantSourceKey(identity, groupOpenid); }
    catch { throw new ConversationStateError(invalid); }
    // Capture primitive keys, so mutating the caller's identity cannot change a bound port.
    const { appId, senderId } = identity;
    return {
      read: () => this.controlled(async () => {
        const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT q.customer_id AS bound_customer_id, CAST(q.id AS CHAR) AS bound_identity_id,
          s.customer_id AS recorded_customer_id, CAST(s.identity_id AS CHAR) AS recorded_identity_id, s.revision, s.context_json
          FROM (SELECT 1) origin
          LEFT JOIN qq_identities q ON q.app_id = ? AND q.sender_id = ?
          LEFT JOIN conversation_state s ON s.source_key = ?`, [appId, senderId, sourceKey]);
        const row = rows[0]!;
        const currentRevision = row.revision === null ? 0 : revision(row.revision);
        const customerId = typeof row.bound_customer_id === "string" ? row.bound_customer_id : undefined;
        const currentBinding = customerId ? bindingId(row.bound_identity_id) : undefined;
        return { revision: currentRevision, ...(customerId ? { customerId, bindingId: currentBinding } : {}),
          ...(customerId && customerId === row.recorded_customer_id && currentBinding === row.recorded_identity_id ? { value: storedValue(row.context_json) } : {}) };
      }),
      write: (expected, input) => this.controlled(async () => {
        rejectUnless(plain(expected) && keys(expected, ["revision"], ["customerId", "bindingId", "value"]));
        const expectedRevision = revision(expected.revision), expectedCustomer = expected.customerId;
        const expectedBinding = bindingId(expected.bindingId);
        rejectUnless(expectedRevision < Number.MAX_SAFE_INTEGER && typeof expectedCustomer === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(expectedCustomer), conflict);
        // Validate and copy before the first await; caller mutation cannot change the write.
        const value = contextValue(input, Date.now(), false);
        let connection: PoolConnection | undefined;
        try {
          connection = await this.pool.getConnection();
          await connection.beginTransaction();
          const [identities] = await connection.execute<RowDataPacket[]>(
            "SELECT customer_id, CAST(id AS CHAR) AS binding_id FROM qq_identities WHERE app_id = ? AND sender_id = ? FOR SHARE", [appId, senderId]);
          rejectUnless(identities[0]?.customer_id === expectedCustomer && identities[0]?.binding_id === expectedBinding, conflict);
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT revision FROM conversation_state WHERE source_key = ? FOR UPDATE", [sourceKey]);
          const currentRevision = rows[0] ? revision(rows[0].revision) : 0;
          rejectUnless(currentRevision === expectedRevision, conflict);
          if (value.focus) {
            const [orders] = await connection.execute<RowDataPacket[]>(
              "SELECT id FROM orders WHERE id = ? AND customer_id = ? FOR SHARE", [value.focus.orderId, expectedCustomer]);
            rejectUnless(orders.length === 1, "未找到当前客户可恢复的订单，请重新明确订单号。");
          }
          contextValue(value, Date.now(), false); // A delayed lock must not extend an expired locator.
          const nextRevision = expectedRevision + 1, encoded = JSON.stringify(value);
          if (rows[0]) {
            const [changed] = await connection.execute<ResultSetHeader>(`UPDATE conversation_state
              SET customer_id = ?, identity_id = ?, revision = ?, context_json = ?, updated_at = UTC_TIMESTAMP(3)
              WHERE source_key = ? AND revision = ?`, [expectedCustomer, expectedBinding, nextRevision, encoded, sourceKey, expectedRevision]);
            rejectUnless(changed.affectedRows === 1, conflict);
          } else {
            // No upsert: a concurrent first insertion must not overwrite another writer.
            await connection.execute("INSERT INTO conversation_state (source_key, customer_id, identity_id, revision, context_json) VALUES (?, ?, ?, ?, ?)",
              [sourceKey, expectedCustomer, expectedBinding, nextRevision, encoded]);
          }
          await connection.commit();
          return { revision: nextRevision, customerId: expectedCustomer, bindingId: expectedBinding, value };
        } catch (error) { await connection?.rollback().catch(() => {}); throw error; }
        finally { connection?.release(); }
      }),
    };
  }
}
