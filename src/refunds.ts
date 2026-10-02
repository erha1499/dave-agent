import { randomUUID } from "node:crypto";
import type { Pool, PoolConnection, PoolOptions, RowDataPacket } from "mysql2/promise";
import { readDatabaseConfig, type QQIdentity } from "./coupon-store.ts";

const unavailable = "未找到当前客户在本会话可操作的模拟退款，请核对订单或重新获取退款方案。";
class BusinessError extends Error {}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type RefundOperation = {
  operationId: string; orderId: string; taskId: string;
  status: "prepared" | "awaiting_confirmation" | "succeeded";
  amountCents: number; expiresAt: string; presentedAt: string | null;
  confirmedAt: string | null; refundId: string | null; simulation: true;
};

export function readRefundDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolOptions {
  if (!env.REFUND_DB_PASSWORD) throw new Error("请先运行售后数据库初始化，设置本机 REFUND_DB_PASSWORD。");
  const user = env.REFUND_DB_USER?.trim() || "dave_agent_refund";
  if (["root", env.DB_USER?.trim() || "dave_agent_read", env.EVAL_DB_USER?.trim() || "dave_agent_eval",
    env.AFTER_SALES_DB_USER?.trim() || "dave_agent_after_sales"].includes(user)) throw new Error("退款账号必须是独立的受限数据库账号。");
  return readDatabaseConfig({ ...env, DB_USER: user, DB_PASSWORD: env.REFUND_DB_PASSWORD });
}

function validate(identity: QQIdentity, sourceKey: string) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(identity?.appId ?? "") || !/^[A-Za-z0-9_-]{1,128}$/.test(identity?.senderId ?? "")
    || !/^[a-f0-9]{64}$/.test(sourceKey)) throw new BusinessError(unavailable);
}
function validateOrder(orderId: string) {
  if (!/^COUPON-2\d{3}$/.test(orderId)) throw new BusinessError("模拟退款首版仅支持 COUPON-2xxx 演示订单。");
}
function operation(row: RowDataPacket): RefundOperation {
  return { operationId: row.operation_id as string, orderId: row.order_id as string, taskId: row.task_id as string,
    status: row.status as RefundOperation["status"], amountCents: row.amount_cents as number,
    expiresAt: (row.expires_at as Date).toISOString(), presentedAt: row.presented_at ? (row.presented_at as Date).toISOString() : null,
    confirmedAt: row.confirmed_at ? (row.confirmed_at as Date).toISOString() : null, refundId: row.refund_id as string | null, simulation: true };
}

export class RefundStore {
  private pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }
  private async controlled<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch (error) {
      if (error instanceof BusinessError) throw error;
      throw new Error("模拟退款暂时不可用，请稍后查询结果或重试。");
    }
  }
  async ping() { await this.controlled(async () => { await this.pool.query("SELECT 1"); }); }
  async close() { await this.controlled(() => this.pool.end()); }
  private async transaction<T>(action: (connection: PoolConnection) => Promise<T>): Promise<T> {
    return this.controlled(async () => {
      const connection = await this.pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await action(connection);
        await connection.commit();
        return result;
      } catch (error) { await connection.rollback().catch(() => {}); throw error; }
      finally { connection.release(); }
    });
  }
  private async lockOrder(connection: PoolConnection, identity: QQIdentity, orderId: string) {
    // Every D2 mutation first locks the same order; concurrent confirmations cannot both execute.
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT o.* FROM orders o
      JOIN qq_identities q ON q.customer_id = o.customer_id JOIN merchant_demo_scenarios s ON s.order_id = o.id
      WHERE o.id = ? AND q.app_id = ? AND q.sender_id = ? FOR UPDATE OF o FOR SHARE OF q, s`, [orderId, identity.appId, identity.senderId]);
    if (!rows[0]) throw new BusinessError(unavailable);
    return rows[0];
  }
  private async current(connection: PoolConnection, identity: QQIdentity, sourceKey: string, order: RowDataPacket) {
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT *, expires_at > UTC_TIMESTAMP(3) AS valid
      FROM refund_operations WHERE order_id = ? FOR UPDATE`, [order.id]);
    const row = rows[0];
    if (row && (row.customer_id !== order.customer_id || row.app_id !== identity.appId || row.sender_id !== identity.senderId
      || row.source_key !== sourceKey)) throw new BusinessError(unavailable);
    return row;
  }
  private async eligible(connection: PoolConnection, sourceKey: string, order: RowDataPacket, existing?: RowDataPacket) {
    const [items] = await connection.execute<RowDataPacket[]>("SELECT * FROM order_items WHERE order_id = ? FOR SHARE", [order.id]);
    const [coupons] = await connection.execute<RowDataPacket[]>(`SELECT c.*, c.expires_at > UTC_TIMESTAMP(3) AS valid
      FROM coupons c JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = ? FOR UPDATE OF c FOR SHARE OF i`, [order.id]);
    const [payments] = await connection.execute<RowDataPacket[]>("SELECT status, amount_cents FROM payments WHERE order_id = ? FOR SHARE", [order.id]);
    const [refunds] = await connection.execute<RowDataPacket[]>("SELECT id FROM refunds WHERE order_id = ? FOR SHARE", [order.id]);
    if (order.status !== "paid" || !Number.isSafeInteger(order.paid_cents) || order.paid_cents <= 0 || order.paid_cents !== order.total_cents || order.refunded_cents !== 0
      || items.length !== 1 || items[0]!.quantity !== 1 || items[0]!.shop_id !== order.shop_id || items[0]!.total_cents !== order.paid_cents
      || coupons.length !== 1 || coupons[0]!.status !== "unused" || !coupons[0]!.valid || coupons[0]!.redeemed_at !== null
      || payments.length !== 1 || payments[0]!.status !== "succeeded" || payments[0]!.amount_cents !== order.paid_cents || refunds.length !== 0) {
      throw new BusinessError("首版仅支持已全额支付、未退款、单张未核销且未过期的演示团购券。");
    }
    const [tasks] = await connection.execute<RowDataPacket[]>("SELECT * FROM merchant_requests WHERE order_id = ? FOR SHARE", [order.id]);
    const task = tasks[0];
    if (!task || task.customer_id !== order.customer_id || task.source_key !== sourceKey) throw new BusinessError(unavailable);
    if (task.status !== "approved" || !Number.isSafeInteger(task.approved_amount_cents) || task.approved_amount_cents < order.paid_cents
      || task.amount_cents !== order.paid_cents || (existing && (existing.task_id !== task.task_id || existing.amount_cents !== order.paid_cents))) {
      throw new BusinessError("需要本会话商家同意的整笔退款方案，当前审批或金额不满足条件，请重新查询协商结果。");
    }
    return { task, coupon: coupons[0]! };
  }
  private async decisionTime(connection: PoolConnection, coupon: RowDataPacket, existing?: RowDataPacket) {
    const [rows] = await connection.query<RowDataPacket[]>("SELECT UTC_TIMESTAMP(3) AS decision_at");
    const now = rows[0]!.decision_at as Date;
    // Eligibility/authorization locks may have waited past expiry. This DB timestamp is the decision point.
    if (existing && (existing.expires_at as Date).getTime() <= now.getTime()) throw new BusinessError("退款方案已过期，请重新获取方案并确认新的操作编号。");
    if ((coupon.expires_at as Date).getTime() <= now.getTime()) throw new BusinessError("团购券已过期，请联系人工客服。");
    return now;
  }
  async prepare(identity: QQIdentity, sourceKey: string, orderId: string): Promise<RefundOperation> {
    validate(identity, sourceKey); validateOrder(orderId);
    return this.transaction(async connection => {
      const order = await this.lockOrder(connection, identity, orderId);
      const existing = await this.current(connection, identity, sourceKey, order);
      if (existing?.status === "succeeded") return operation(existing);
      const { task, coupon } = await this.eligible(connection, sourceKey, order);
      const now = await this.decisionTime(connection, coupon);
      if (existing && (existing.expires_at as Date).getTime() > now.getTime()
        && existing.task_id === task.task_id && existing.amount_cents === order.paid_cents) return operation(existing);
      const id = randomUUID();
      if (existing) {
        // Rotating the ID makes every expired confirmation permanently unusable.
        await connection.execute(`UPDATE refund_operations SET operation_id = ?, status = 'prepared', created_at = UTC_TIMESTAMP(3),
          expires_at = UTC_TIMESTAMP(3) + INTERVAL 15 MINUTE, presented_at = NULL, task_id = ?, amount_cents = ? WHERE order_id = ?`,
        [id, task.task_id, order.paid_cents, orderId]);
      } else {
        await connection.execute(`INSERT INTO refund_operations
          (operation_id, order_id, task_id, customer_id, app_id, sender_id, source_key, amount_cents, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL 15 MINUTE)`,
        [id, orderId, task.task_id, order.customer_id, identity.appId, identity.senderId, sourceKey, order.paid_cents]);
      }
      return operation((await this.current(connection, identity, sourceKey, order))!);
    });
  }
  private async withOperation(identity: QQIdentity, sourceKey: string, operationId: string,
    action: (connection: PoolConnection, order: RowDataPacket, row: RowDataPacket) => Promise<RefundOperation>): Promise<RefundOperation> {
    validate(identity, sourceKey);
    if (!uuid.test(operationId)) throw new BusinessError(unavailable);
    return this.controlled(async () => {
      const [lookup] = await this.pool.execute<RowDataPacket[]>("SELECT order_id FROM refund_operations WHERE operation_id = ?", [operationId]);
      if (!lookup[0]) throw new BusinessError(unavailable);
      return this.transaction(async connection => {
        const order = await this.lockOrder(connection, identity, lookup[0]!.order_id as string);
        const row = await this.current(connection, identity, sourceKey, order);
        if (!row || row.operation_id !== operationId) throw new BusinessError(unavailable);
        if (row.status === "succeeded") return operation(row);
        if (!row.valid) throw new BusinessError("退款方案已过期，请重新获取方案并确认新的操作编号。");
        return action(connection, order, row);
      });
    });
  }
  // Host-only: record delivery only after the fixed summary has actually been sent successfully.
  async markPresented(identity: QQIdentity, sourceKey: string, operationId: string): Promise<RefundOperation> {
    return this.withOperation(identity, sourceKey, operationId, async (connection, order, row) => {
      const { coupon } = await this.eligible(connection, sourceKey, order, row);
      const now = await this.decisionTime(connection, coupon, row);
      await connection.execute(`UPDATE refund_operations SET status = 'awaiting_confirmation', presented_at = COALESCE(presented_at, ?)
        WHERE operation_id = ?`, [now, operationId]);
      return operation((await this.current(connection, identity, sourceKey, order))!);
    });
  }
  // Host-only: no model tool can call this method or supply a refund amount.
  async confirm(identity: QQIdentity, sourceKey: string, operationId: string): Promise<RefundOperation> {
    return this.withOperation(identity, sourceKey, operationId, async (connection, order, row) => {
      if (row.status !== "awaiting_confirmation" || !row.presented_at) throw new BusinessError("退款方案尚未成功展示，请重新获取方案后再确认。");
      const { coupon } = await this.eligible(connection, sourceKey, order, row);
      const now = await this.decisionTime(connection, coupon, row);
      const refundId = randomUUID();
      await connection.execute(`INSERT INTO refunds (id, order_id, status, amount_cents, reason, completed_at)
        VALUES (?, ?, 'succeeded', ?, 'D2 模拟退款；不涉及真实支付渠道', ?)`, [refundId, order.id, row.amount_cents, now]);
      await connection.execute("UPDATE orders SET status = 'refunded', refunded_cents = ? WHERE id = ?", [row.amount_cents, order.id]);
      await connection.execute("UPDATE coupons SET status = 'refunded' WHERE id = ?", [coupon.id]);
      await connection.execute(`UPDATE refund_operations SET status = 'succeeded', confirmed_at = ?, refund_id = ?
        WHERE operation_id = ?`, [now, refundId, operationId]);
      return operation((await this.current(connection, identity, sourceKey, order))!);
    });
  }
  async get(identity: QQIdentity, sourceKey: string, orderId: string): Promise<RefundOperation | undefined> {
    validate(identity, sourceKey); validateOrder(orderId);
    return this.controlled(async () => {
      const [rows] = await this.pool.execute<RowDataPacket[]>(`SELECT r.* FROM refund_operations r
        JOIN orders o ON o.id = r.order_id AND o.customer_id = r.customer_id JOIN qq_identities q ON q.customer_id = o.customer_id
        WHERE r.order_id = ? AND r.source_key = ? AND r.app_id = ? AND r.sender_id = ? AND q.app_id = ? AND q.sender_id = ?`,
      [orderId, sourceKey, identity.appId, identity.senderId, identity.appId, identity.senderId]);
      return rows[0] ? operation(rows[0]) : undefined;
    });
  }
}
