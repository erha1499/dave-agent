import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, PoolOptions, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { readDatabaseConfig, type QQIdentity } from "./coupon-store.ts";

const unavailable = "未找到当前客户在本会话可操作的演示协商订单，请核对订单号或联系人工客服。";
const failure = "演示商家协商暂时不可用，请稍后重试。";
export class MerchantBusinessError extends Error {}
const BusinessError = MerchantBusinessError;
// Confirmation commands must survive display/copy without hidden characters changing their meaning.
export const merchantReasonControls = /[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u;

type MerchantStatus = "pending" | "approved" | "rejected" | "timed_out";
export type MerchantTask = {
  taskId: string; orderId: string; status: MerchantStatus; reason: string;
  amountCents: number; approvedAmountCents: number | null;
  createdAt: string; dueAt: string; completedAt: string | null; simulation: true;
};
export type MerchantReplyRoute = { groupOpenid: string; messageId: string; timestamp: string };
export type MerchantNotification = MerchantReplyRoute & {
  taskId: string; orderId: string; sourceKey: string; appId: string; senderId: string;
};

export function merchantSourceKey(identity: QQIdentity, conversationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(identity.appId) || !/^[A-Za-z0-9_-]{1,128}$/.test(identity.senderId)
    || !conversationId || conversationId.length > 256) throw new Error("模拟协商会话标识无效。");
  return createHash("sha256").update(JSON.stringify([identity.appId, identity.senderId, conversationId])).digest("hex");
}

function notificationKey(taskId: string, appId: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(taskId)
    || !/^[A-Za-z0-9_-]{1,32}$/.test(appId)) throw new BusinessError("模拟商家通知标识无效。");
}

export function readAfterSalesDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolOptions {
  if (!env.AFTER_SALES_DB_PASSWORD) throw new Error("请先运行售后数据库初始化，设置本机 AFTER_SALES_DB_PASSWORD。");
  const user = env.AFTER_SALES_DB_USER?.trim() || "dave_agent_after_sales";
  if (["root", env.DB_USER?.trim() || "dave_agent_read", env.EVAL_DB_USER?.trim() || "dave_agent_eval"].includes(user)) throw new Error("售后账号必须是独立的受限数据库账号。");
  return readDatabaseConfig({ ...env, DB_USER: user, DB_PASSWORD: env.AFTER_SALES_DB_PASSWORD });
}

function validate(identity: QQIdentity, sourceKey: string, orderId: string, reason?: string) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(identity?.appId ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(identity?.senderId ?? "")
    || !/^[a-f0-9]{64}$/.test(sourceKey)) throw new BusinessError(unavailable);
  if (!/^COUPON-2\d{3}$/.test(orderId)) throw new BusinessError("商家协商首版仅支持 COUPON-2001、COUPON-2002、COUPON-2003 演示订单。");
  if (reason !== undefined && (!reason.trim() || [...reason.trim()].length > 200 || merchantReasonControls.test(reason))) {
    throw new BusinessError("协商原因应为 1–200 字的单行文本。");
  }
}

function task(row: RowDataPacket): MerchantTask {
  return {
    taskId: row.task_id as string, orderId: row.order_id as string, status: row.status as MerchantStatus,
    reason: row.reason as string, amountCents: row.amount_cents as number, approvedAmountCents: row.approved_amount_cents as number | null,
    createdAt: (row.created_at as Date).toISOString(), dueAt: (row.due_at as Date).toISOString(),
    completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null, simulation: true,
  };
}

export class AfterSalesStore {
  private pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  private async controlled<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new Error(failure);
    }
  }

  async ping() { await this.controlled(async () => { await this.pool.query("SELECT 1"); }); }
  async close() { await this.controlled(() => this.pool.end()); }

  private async eligible(connection: PoolConnection, identity: QQIdentity, orderId: string) {
    // Lock every fact used for authorization/eligibility without granting business write privileges.
    const [orders] = await connection.execute<RowDataPacket[]>(`SELECT o.*, s.outcome, s.delay_ms
      FROM orders o JOIN qq_identities q ON q.customer_id = o.customer_id
      JOIN merchant_demo_scenarios s ON s.order_id = o.id
      WHERE o.id = ? AND q.app_id = ? AND q.sender_id = ? FOR SHARE`, [orderId, identity.appId, identity.senderId]);
    const order = orders[0];
    if (!order) throw new BusinessError(unavailable);
    const [items] = await connection.execute<RowDataPacket[]>("SELECT * FROM order_items WHERE order_id = ? FOR SHARE", [orderId]);
    const [coupons] = await connection.execute<RowDataPacket[]>(`SELECT c.*, c.expires_at > UTC_TIMESTAMP(3) AS valid
      FROM coupons c JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = ? FOR SHARE`, [orderId]);
    const [payments] = await connection.execute<RowDataPacket[]>("SELECT status, amount_cents FROM payments WHERE order_id = ? FOR SHARE", [orderId]);
    const [refunds] = await connection.execute<RowDataPacket[]>("SELECT id FROM refunds WHERE order_id = ? FOR SHARE", [orderId]);
    if (order.status !== "paid" || order.paid_cents <= 0 || order.paid_cents !== order.total_cents || order.refunded_cents !== 0
      || items.length !== 1 || items[0]!.quantity !== 1 || items[0]!.total_cents !== order.paid_cents
      || coupons.length !== 1 || coupons[0]!.status !== "unused" || !coupons[0]!.valid
      || payments.length !== 1 || payments[0]!.status !== "succeeded" || payments[0]!.amount_cents !== order.paid_cents || refunds.length !== 0) {
      throw new BusinessError("首版仅支持已全额支付、未退款、单张未核销且未过期的演示团购券。");
    }
    return order;
  }

  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    return this.controlled(async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback().catch(() => {}); throw error; }
      finally { connection.release(); }
    });
  }

  async prepare(identity: QQIdentity, sourceKey: string, orderId: string, reason: string) {
    validate(identity, sourceKey, orderId, reason);
    return this.transaction(async connection => {
      const order = await this.eligible(connection, identity, orderId);
      const [existing] = await connection.execute<RowDataPacket[]>("SELECT source_key, customer_id FROM merchant_requests WHERE order_id = ?", [orderId]);
      if (existing[0] && (existing[0].source_key !== sourceKey || existing[0].customer_id !== order.customer_id)) throw new BusinessError(unavailable);
      return { simulation: true as const, status: "confirmation_required" as const, orderId, amountCents: order.paid_cents as number,
        confirmationText: `确认联系商家 ${orderId} 原因：${reason.trim()}` };
    });
  }

  // Called only after the trusted QQ entry point parses the user's literal confirmation.
  async request(identity: QQIdentity, sourceKey: string, orderId: string, reason: string, route?: MerchantReplyRoute): Promise<MerchantTask> {
    validate(identity, sourceKey, orderId, reason);
    if (route && (typeof route.groupOpenid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(route.groupOpenid)
      || typeof route.messageId !== "string" || !/^[\x21-\x7e]{1,512}$/.test(route.messageId) || typeof route.timestamp !== "string"
      || !Number.isFinite(Date.parse(route.timestamp)) || !/^\d{4}-/.test(new Date(route.timestamp).toISOString())
      || new Date(route.timestamp).getUTCFullYear() < 1000
      || merchantSourceKey(identity, route.groupOpenid) !== sourceKey)) throw new BusinessError("模拟商家通知路由无效。");
    return this.transaction(async connection => {
      const order = await this.eligible(connection, identity, orderId);
      const taskId = randomUUID();
      // ponytail: one persistent request per demo order; add explicit attempt IDs when retries become a product requirement.
      await connection.execute(`INSERT INTO merchant_requests
        (task_id, order_id, customer_id, source_key, reason, amount_cents, mock_outcome, due_at, deadline_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3)), UTC_TIMESTAMP(3) + INTERVAL 8 SECOND)
        ON DUPLICATE KEY UPDATE task_id = task_id`,
      [taskId, orderId, order.customer_id, sourceKey, reason.trim(), order.paid_cents, order.outcome, Number(order.delay_ms) * 1000]);
      const [rows] = await connection.execute<RowDataPacket[]>("SELECT * FROM merchant_requests WHERE order_id = ? FOR SHARE", [orderId]);
      const existing = rows[0]!;
      if (existing.source_key !== sourceKey || existing.customer_id !== order.customer_id) throw new BusinessError(unavailable);
      // Only the original QQ confirmation establishes a route; replay cannot redirect or revive a notification.
      if (route && existing.task_id === taskId) await connection.execute(`INSERT INTO merchant_notifications
        (task_id, app_id, sender_id, group_openid, message_id, message_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [taskId, identity.appId, identity.senderId, route.groupOpenid, route.messageId, new Date(route.timestamp)]);
      return task(existing);
    });
  }

  async listNotifications(appId: string): Promise<MerchantNotification[]> {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(appId)) throw new BusinessError("模拟商家通知标识无效。");
    return this.controlled(async () => {
      const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT n.*, r.order_id, r.source_key
        FROM merchant_notifications n JOIN merchant_requests r ON r.task_id = n.task_id
        WHERE n.app_id = ? AND n.status = 'pending' AND r.status <> 'pending'
        ORDER BY r.completed_at, n.task_id LIMIT 20`, [appId]);
      return rows.map(row => ({ taskId: row.task_id as string, orderId: row.order_id as string,
        sourceKey: row.source_key as string, appId: row.app_id as string, senderId: row.sender_id as string,
        groupOpenid: row.group_openid as string, messageId: row.message_id as string,
        timestamp: (row.message_at as Date).toISOString() }));
    });
  }

  async claimNotification(taskId: string, appId: string): Promise<boolean> {
    notificationKey(taskId, appId);
    return this.controlled(async () => {
      // ponytail: one attempt per notification; a crash after claim falls back to user queries rather than risking duplicate sends.
      const [changed] = await this.pool.execute<ResultSetHeader>(`UPDATE merchant_notifications n
        JOIN merchant_requests r ON r.task_id = n.task_id
        SET n.status = 'claimed', n.claimed_at = UTC_TIMESTAMP(3)
        WHERE n.task_id = ? AND n.app_id = ? AND n.status = 'pending' AND r.status <> 'pending'`, [taskId, appId]);
      return changed.affectedRows === 1;
    });
  }

  async finishNotification(taskId: string, appId: string, status: "sent" | "deferred" | "unknown"): Promise<void> {
    notificationKey(taskId, appId);
    if (!["sent", "deferred", "unknown"].includes(status)) throw new BusinessError("模拟商家通知状态无效。");
    await this.controlled(async () => {
      const [changed] = await this.pool.execute<ResultSetHeader>(`UPDATE merchant_notifications
        SET status = ?, finished_at = UTC_TIMESTAMP(3)
        WHERE task_id = ? AND app_id = ? AND status = 'claimed'`, [status, taskId, appId]);
      if (changed.affectedRows !== 1) throw new BusinessError("模拟商家通知尚未领取或已经结束。");
    });
  }

  async getTask(identity: QQIdentity, sourceKey: string, orderId: string): Promise<MerchantTask | undefined> {
    validate(identity, sourceKey, orderId);
    return this.controlled(async () => {
      const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT r.* FROM merchant_requests r
        JOIN orders o ON o.id = r.order_id AND o.customer_id = r.customer_id
        JOIN qq_identities q ON q.customer_id = o.customer_id
        WHERE r.order_id = ? AND r.source_key = ? AND q.app_id = ? AND q.sender_id = ?`, [orderId, sourceKey, identity.appId, identity.senderId]);
      return rows[0] ? task(rows[0]) : undefined;
    });
  }

  async applyResult(result: { taskId: string; orderId: string; status: "approved" | "rejected"; approvedAmountCents: number | null }): Promise<boolean> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(result.taskId) || !/^COUPON-2\d{3}$/.test(result.orderId)
      || !["approved", "rejected"].includes(result.status)
      || (result.status === "approved" ? !Number.isSafeInteger(result.approvedAmountCents) || (result.approvedAmountCents ?? 0) <= 0 : result.approvedAmountCents !== null)) {
      throw new BusinessError("模拟商家回调格式无效。");
    }
    return this.controlled(async () => {
      const [changed] = await this.pool.execute<ResultSetHeader>(`UPDATE merchant_requests
        SET status = ?, approved_amount_cents = ?, completed_at = UTC_TIMESTAMP(3)
        WHERE task_id = ? AND order_id = ? AND status = 'pending' AND deadline_at > UTC_TIMESTAMP(3)
        AND (? IS NULL OR ? <= amount_cents)`,
      [result.status, result.approvedAmountCents, result.taskId, result.orderId, result.approvedAmountCents, result.approvedAmountCents]);
      return changed.affectedRows === 1;
    });
  }

  async processDue(): Promise<number> {
    return this.controlled(async () => {
      const [expired] = await this.pool.execute<ResultSetHeader>(`UPDATE merchant_requests
        SET status = 'timed_out', completed_at = UTC_TIMESTAMP(3)
        WHERE status = 'pending' AND deadline_at <= UTC_TIMESTAMP(3)`);
      const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT task_id, order_id, mock_outcome, amount_cents FROM merchant_requests
        WHERE status = 'pending' AND mock_outcome <> 'timeout' AND due_at <= UTC_TIMESTAMP(3) AND deadline_at > UTC_TIMESTAMP(3)
        ORDER BY due_at LIMIT 100`);
      let processed = expired.affectedRows;
      for (const row of rows) {
        const approved = row.mock_outcome === "approve";
        if (await this.applyResult({ taskId: row.task_id as string, orderId: row.order_id as string,
          status: approved ? "approved" : "rejected", approvedAmountCents: approved ? row.amount_cents as number : null })) processed++;
      }
      return processed;
    });
  }
}

export function startMockMerchant(store: AfterSalesStore, options: { intervalMs?: number; afterProcess?: () => Promise<void> } = {}): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 500;
  if (!Number.isInteger(intervalMs) || intervalMs < 10 || intervalMs > 5000) throw new Error("模拟商家轮询间隔应为 10–5000 毫秒。");
  let active: Promise<void> | undefined;
  let notifying: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (active || stopped) return;
    active = store.processDue().then(() => {
      // Model-backed notifications may be slow; merchant deadlines must keep advancing independently.
      if (!stopped && !notifying && options.afterProcess) notifying = Promise.resolve().then(options.afterProcess)
        .catch(() => { console.error("[merchant] 模拟商家通知处理失败，可按订单号查询结果。"); })
        .finally(() => { notifying = undefined; });
    }).catch(() => { console.error("[merchant] 模拟商家处理暂时失败，将在下轮重试。"); })
      .finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => { stopped = true; clearInterval(timer); await Promise.all([active, notifying]); };
}
