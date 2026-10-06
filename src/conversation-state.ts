import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { merchantSourceKey } from "./after-sales.ts";
import type { QQIdentity } from "./coupon-store.ts";
import type { TrustedAmountReference } from "./support-context.ts";
import type { TrustedPolicyTopic } from "./support-controller.ts";
import { validPolicyTopicFields } from "./support-reference-selection.ts";
import { validateTaskContext, type TaskContext } from "./support-task-context.ts";

export type SupportContextOrderChoices = {
  candidates: Array<{ requestId: string; orderId: string; expiresAt: number }>;
  overflow: boolean; selectionRequired: boolean; pending: boolean;
};
type SelectedChoices<T> = { candidates: T[]; overflow: boolean; selectionRequired: boolean; selectedRequestId?: string };
export type SupportContextPolicyChoices = SelectedChoices<{
  topic: Omit<TrustedPolicyTopic, "sourceKey" | "groupOpenid">; expiresAt: number;
}>;
export type SupportContextAmountChoices = SelectedChoices<{
  reference: Omit<TrustedAmountReference, "sourceKey" | "groupOpenid">; expiresAt: number;
}>;
export type SupportContextValue = {
  focus?: { orderId: string; requestId: string; source: "explicit" | "selection"; selectedAt: number; expiresAt: number };
  requiresRestatement: boolean;
} & ({ version: 1 } | { version: 2; orderChoices?: SupportContextOrderChoices }
  | { version: 3; orderChoices?: SupportContextOrderChoices; policyChoices?: SupportContextPolicyChoices;
      amountChoices?: SupportContextAmountChoices; pendingReferenceKind?: "order" | "policy" }
  | { version: 4; orderChoices?: SupportContextOrderChoices; policyChoices?: SupportContextPolicyChoices;
      amountChoices?: SupportContextAmountChoices; pendingReferenceKind?: "order" | "policy"; taskContext?: TaskContext });
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

const validOrderId = (value: unknown): value is string => typeof value === "string" && /^COUPON-\d{4}$/.test(value);
const validRequestId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
const validExpiry = (value: unknown, now: number): value is number => typeof value === "number" && Number.isSafeInteger(value)
  && value > 0 && value <= 8.64e15 && value <= now + ttlMs;

function policyCandidate(input: unknown): SupportContextPolicyChoices["candidates"][number] {
  rejectUnless(plain(input) && keys(input, ["topic", "expiresAt"]));
  const topic = input.topic;
  rejectUnless(plain(topic) && keys(topic, ["requestId", "originalQuery", "orderId", "scope", "sources"], ["intent", "priorQueries"])
    && validRequestId(topic.requestId) && plain(topic.scope) && keys(topic.scope, ["shopId", "productId"])
    && Array.isArray(topic.sources) && Array.from(topic.sources).every(source => plain(source) && keys(source, ["sourceId", "version"]))
    && (topic.priorQueries === undefined || Array.isArray(topic.priorQueries) && Array.from(topic.priorQueries).every(prior =>
      plain(prior) && keys(prior, ["requestId", "originalQuery"]) && validRequestId(prior.requestId)))
    && validPolicyTopicFields(topic));
  return { topic: structuredClone(topic), expiresAt: input.expiresAt as number }; // Expiry checked with the shared choice clock below.
}
function amountCandidate(input: unknown): SupportContextAmountChoices["candidates"][number] {
  rejectUnless(plain(input) && keys(input, ["reference", "expiresAt"]));
  const reference = input.reference;
  rejectUnless(plain(reference) && keys(reference, ["requestId", "orderId", "itemId", "productId", "field", "paidCents", "orderVersion"])
    && validRequestId(reference.requestId) && validOrderId(reference.orderId) && validRequestId(reference.itemId) && validRequestId(reference.productId)
    && reference.field === "item_paid_unit" && typeof reference.paidCents === "number" && Number.isSafeInteger(reference.paidCents) && reference.paidCents > 0
    && typeof reference.orderVersion === "string" && /^[a-f0-9]{64}$/.test(reference.orderVersion));
  return { reference: { requestId: reference.requestId, orderId: reference.orderId, itemId: reference.itemId, productId: reference.productId,
    field: reference.field, paidCents: reference.paidCents, orderVersion: reference.orderVersion }, expiresAt: input.expiresAt as number };
}
function selectedChoices<T extends { expiresAt: number }>(input: unknown, now: number, limit: number,
  parse: (value: unknown) => T, requestId: (value: T) => string): SelectedChoices<T> {
  rejectUnless(plain(input) && keys(input, ["candidates", "overflow", "selectionRequired"], ["selectedRequestId"])
    && Array.isArray(input.candidates) && input.candidates.length <= limit
    && typeof input.overflow === "boolean" && typeof input.selectionRequired === "boolean");
  const candidates = Array.from(input.candidates, parse), requests = candidates.map(requestId);
  rejectUnless(candidates.every(candidate => validExpiry(candidate.expiresAt, now)) && new Set(requests).size === candidates.length
    && (input.selectedRequestId === undefined || validRequestId(input.selectedRequestId) && requests.includes(input.selectedRequestId)));
  const remaining = candidates.filter(candidate => candidate.expiresAt > now);
  const selectedRequestId = remaining.some(candidate => requestId(candidate) === input.selectedRequestId) ? input.selectedRequestId as string : undefined;
  return { candidates: remaining, overflow: input.overflow,
    selectionRequired: input.selectionRequired || input.overflow || candidates.length > 1 || Boolean(input.selectedRequestId && !selectedRequestId),
    ...(selectedRequestId ? { selectedRequestId } : {}) };
}

// Historical references are not current facts, authorization, approval or reusable presentation tokens.
export function validateSupportContextValue(input: unknown, options: { now?: number; allowExpiredFocus?: boolean } = {}): SupportContextValue {
  const now = options.now ?? Date.now();
  rejectUnless(Number.isSafeInteger(now) && now > 0 && now <= 8.64e15);
  rejectUnless(plain(input) && (input.version === 1 || input.version === 2 || input.version === 3 || input.version === 4)
    && keys(input, ["version", "requiresRestatement"], input.version === 1 ? ["focus"] : input.version === 2 ? ["focus", "orderChoices"]
      : ["focus", "orderChoices", "policyChoices", "amountChoices", "pendingReferenceKind", ...(input.version === 4 ? ["taskContext"] : [])])
    && typeof input.requiresRestatement === "boolean");
  const value: SupportContextValue = { version: input.version, requiresRestatement: input.requiresRestatement };
  if (input.focus !== undefined) {
    const focus = input.focus;
    rejectUnless(plain(focus) && keys(focus, ["orderId", "requestId", "source", "selectedAt", "expiresAt"]));
    rejectUnless(validOrderId(focus.orderId) && validRequestId(focus.requestId)
      && (focus.source === "explicit" || focus.source === "selection"));
    rejectUnless(typeof focus.selectedAt === "number" && Number.isSafeInteger(focus.selectedAt) && focus.selectedAt > 0 && focus.selectedAt <= now
      && typeof focus.expiresAt === "number" && Number.isSafeInteger(focus.expiresAt) && focus.expiresAt <= 8.64e15
      && focus.expiresAt > focus.selectedAt && focus.expiresAt - focus.selectedAt <= ttlMs
      && (options.allowExpiredFocus || focus.expiresAt > now));
    if (focus.expiresAt <= now) value.requiresRestatement = true;
    else value.focus = { orderId: focus.orderId, requestId: focus.requestId, source: focus.source,
      selectedAt: focus.selectedAt, expiresAt: focus.expiresAt };
  }
  if (value.version !== 1 && input.orderChoices !== undefined) {
    const choices = input.orderChoices;
    rejectUnless(plain(choices) && keys(choices, ["candidates", "overflow", "selectionRequired", "pending"])
      && Array.isArray(choices.candidates) && choices.candidates.length <= 3
      && typeof choices.overflow === "boolean" && typeof choices.selectionRequired === "boolean" && typeof choices.pending === "boolean");
    const orders = new Set<string>(), requests = new Set<string>();
    const candidates = Array.from(choices.candidates, candidate => {
      rejectUnless(plain(candidate) && keys(candidate, ["requestId", "orderId", "expiresAt"])
        && validRequestId(candidate.requestId) && validOrderId(candidate.orderId)
        && validExpiry(candidate.expiresAt, now));
      rejectUnless(!orders.has(candidate.orderId) && !requests.has(candidate.requestId));
      orders.add(candidate.orderId); requests.add(candidate.requestId);
      return { requestId: candidate.requestId, orderId: candidate.orderId, expiresAt: candidate.expiresAt };
    });
    // Validate all entries before expiry filtering; expiry cannot hide malformed or duplicate references.
    const remaining = candidates.filter(candidate => candidate.expiresAt > now);
    value.orderChoices = { candidates: remaining, overflow: choices.overflow, pending: choices.pending,
      selectionRequired: choices.selectionRequired || choices.overflow || candidates.length > 1 };
    if (remaining.length !== candidates.length && !value.focus) value.requiresRestatement = true;
  }
  if (value.version === 3 || value.version === 4) {
    rejectUnless(input.pendingReferenceKind === undefined || input.pendingReferenceKind === "order" || input.pendingReferenceKind === "policy");
    if (input.pendingReferenceKind !== undefined) value.pendingReferenceKind = input.pendingReferenceKind;
    rejectUnless(!value.orderChoices || value.orderChoices.pending === (value.pendingReferenceKind === "order"));
    if (input.policyChoices !== undefined) {
      value.policyChoices = selectedChoices(input.policyChoices, now, 3, policyCandidate, candidate => candidate.topic.requestId);
      if (value.policyChoices.candidates.length !== (input.policyChoices as { candidates: unknown[] }).candidates.length && !value.focus) value.requiresRestatement = true;
    }
    if (input.amountChoices !== undefined) {
      const sources = new Set<string>();
      value.amountChoices = selectedChoices(input.amountChoices, now, 2, candidate => {
        const parsed = amountCandidate(candidate), reference = parsed.reference;
        const source = JSON.stringify([reference.orderId, reference.itemId, reference.productId]);
        rejectUnless(!sources.has(source)); sources.add(source); return parsed;
      }, candidate => candidate.reference.requestId);
      if (value.amountChoices.candidates.length !== (input.amountChoices as { candidates: unknown[] }).candidates.length && !value.focus) value.requiresRestatement = true;
    }
  }
  if (value.version === 4 && input.taskContext !== undefined) {
    rejectUnless(plain(input.taskContext) && keys(input.taskContext, ["selectionRequired", "overflow"], ["selected"])
      && (input.taskContext.selected === undefined || plain(input.taskContext.selected)
        && keys(input.taskContext.selected, ["taskId", "orderId", "requestId", "selectedAt", "expiresAt"])));
    const context = validateTaskContext(input.taskContext, now);
    rejectUnless(context);
    value.taskContext = context;
  }
  return value;
}
function storedValue(input: unknown): SupportContextValue {
  try { return validateSupportContextValue(typeof input === "string" ? JSON.parse(input) : input, { allowExpiredFocus: true }); }
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
        let value = validateSupportContextValue(input);
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
          const orderIds = new Set([...(value.focus ? [value.focus.orderId] : []),
            ...(value.version !== 1 ? value.orderChoices?.candidates.map(candidate => candidate.orderId) ?? [] : []),
            ...(value.version === 3 || value.version === 4 ? value.policyChoices?.candidates.flatMap(candidate => candidate.topic.orderId ? [candidate.topic.orderId] : []) ?? [] : []),
            ...(value.version === 3 || value.version === 4 ? value.amountChoices?.candidates.map(candidate => candidate.reference.orderId) ?? [] : [])]);
          for (const orderId of orderIds) {
            const [orders] = await connection.execute<RowDataPacket[]>(
              "SELECT id FROM orders WHERE id = ? AND customer_id = ? FOR SHARE", [orderId, expectedCustomer]);
            rejectUnless(orders.length === 1, "未找到当前客户可恢复的订单，请重新明确订单号。");
          }
          if (value.version === 4 && value.taskContext?.selected) {
            const selected = value.taskContext.selected;
            const [tasks] = await connection.execute<RowDataPacket[]>(`SELECT r.task_id FROM merchant_requests r
              JOIN orders o ON o.id = r.order_id AND o.customer_id = r.customer_id
              WHERE r.task_id = ? AND r.order_id = ? AND r.source_key = ? AND r.customer_id = ? AND r.identity_id = ? FOR SHARE`,
            [selected.taskId, selected.orderId, sourceKey, expectedCustomer, expectedBinding]);
            rejectUnless(tasks.length === 1, "未找到当前绑定可恢复的协商任务，请重新选择任务。");
          }
          value = validateSupportContextValue(value); // A delayed lock cannot renew a locator or retain expired candidates.
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
