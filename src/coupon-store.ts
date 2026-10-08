import type { Pool, PoolConnection, PoolOptions, RowDataPacket } from "mysql2/promise";
import { rankKnowledge } from "./knowledge-retrieval.ts";
import type { RetrievalDocument } from "./retrieval-ranking.ts";

export type QQIdentity = { appId: string; senderId: string };
const unavailableOrder = "未找到当前客户可查询的订单，请核对订单号或联系人工客服。";
const databaseFailure = "演示业务数据暂时无法查询，请稍后重试。";
export class OrderAccessError extends Error {}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolOptions {
  const host = env.DB_HOST?.trim() || "127.0.0.1";
  const portText = env.DB_PORT?.trim() || "13306";
  const port = Number(portText);
  const database = env.DB_NAME?.trim() || "dave_agent";
  const user = env.DB_USER?.trim() || "dave_agent_read";
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error("DB_HOST 格式无效。");
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DB_PORT 应为 1–65535 的整数。");
  if (!/^[A-Za-z0-9_]{1,64}$/.test(database) || !/^[A-Za-z0-9_]{1,64}$/.test(user)) throw new Error("DB_NAME 或 DB_USER 格式无效。");
  if (!env.DB_PASSWORD) throw new Error("请设置本机 DB_PASSWORD。");
  return {
    host, port, database, user, password: env.DB_PASSWORD,
    charset: "utf8mb4", timezone: "Z", connectTimeout: 5000, connectionLimit: 5, queueLimit: 20,
    multipleStatements: false, supportBigNumbers: true,
  };
}

function validIdentity(identity: QQIdentity) {
  return typeof identity?.appId === "string" && typeof identity.senderId === "string"
    && /^[A-Za-z0-9_-]{1,32}$/.test(identity.appId) && /^[A-Za-z0-9_-]{1,128}$/.test(identity.senderId);
}

function date(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export class CouponStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async select(sql: string, values: Array<string | null> = [], connection: Pool | PoolConnection = this.pool) {
    try {
      const [rows] = await connection.execute<RowDataPacket[]>({ sql, timeout: 5000 }, values);
      return rows;
    } catch {
      // Do not expose SQL, credentials, connection addresses or driver diagnostics to the model.
      throw new Error(databaseFailure);
    }
  }

  async ping() {
    await this.select("SELECT /*+ MAX_EXECUTION_TIME(3000) */ 1 AS ready");
  }

  async close() {
    try { await this.pool.end(); } catch { throw new Error(databaseFailure); }
  }

  async resolveCustomer(identity: QQIdentity): Promise<string | undefined> {
    if (!validIdentity(identity)) return undefined;
    const rows = await this.select("SELECT /*+ MAX_EXECUTION_TIME(3000) */ customer_id FROM qq_identities WHERE app_id = ? AND sender_id = ? LIMIT 1", [identity.appId, identity.senderId]);
    return rows[0]?.customer_id as string | undefined;
  }

  async listOrders(identity: QQIdentity) {
    if (!validIdentity(identity)) throw new OrderAccessError(unavailableOrder);
    // One statement keeps identity and all list facts in the same read snapshot.
    const rows = await this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */
      o.id, o.status, o.paid_cents, o.refunded_cents, o.created_at, s.name AS shop_name,
      (SELECT p.name FROM order_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product_name,
      (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
      (SELECT JSON_ARRAYAGG(c.status) FROM coupons c JOIN order_items i ON i.id = c.order_item_id
        WHERE i.order_id = o.id) AS coupon_statuses
      FROM orders o JOIN qq_identities q ON q.customer_id = o.customer_id
      JOIN shops s ON s.id = o.shop_id
      WHERE q.app_id = ? AND q.sender_id = ?
      ORDER BY o.created_at DESC, o.id DESC LIMIT 4`, [identity.appId, identity.senderId]);
    // An unbound identity must not look like a successfully queried empty customer.
    if (!rows.length && !await this.resolveCustomer(identity)) throw new OrderAccessError(unavailableOrder);
    const orders = rows.slice(0, 3).map(row => {
      let couponStatuses: unknown;
      try { couponStatuses = typeof row.coupon_statuses === "string" ? JSON.parse(row.coupon_statuses) : row.coupon_statuses ?? []; }
      catch { throw new Error(databaseFailure); }
      if (!Array.isArray(couponStatuses) || couponStatuses.length > 100
        || couponStatuses.some(status => typeof status !== "string") || Number(row.item_count) > 100) throw new Error(databaseFailure);
      return { id: row.id as string, status: row.status as string, paidCents: row.paid_cents as number,
        refundedCents: row.refunded_cents as number, createdAt: date(row.created_at),
        shopName: row.shop_name as string,
        productName: `${row.product_name ?? "订单商品"}${Number(row.item_count) > 1 ? "等" : ""}`,
        couponStatuses: couponStatuses as string[] };
    });
    // ponytail: latest three orders only; add pagination when browsing beyond an explicit order ID is needed.
    return { source: "demo-database" as const, asOf: new Date().toISOString(), orders, hasMore: rows.length > 3 };
  }

  async getOrder(identity: QQIdentity, orderId: string) {
    if (!/^COUPON-\d{4}$/.test(orderId)) throw new Error("演示订单号格式为 COUPON-1001。");
    if (!validIdentity(identity)) throw new OrderAccessError(unavailableOrder);
    const notFound = new OrderAccessError(unavailableOrder);
    let connection: PoolConnection | undefined;
    let started = false;
    try {
      connection = await this.pool.getConnection();
      // One-shot transaction settings cannot change the next borrower's session defaults.
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      await connection.beginTransaction();
      started = true;
      const asOf = new Date().toISOString();
      // Re-resolve the trusted sender on every call; never accept a customer ID from model arguments.
      // The authorization row and all business facts share the first SELECT's consistent snapshot.
      const rows = await this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */
        o.id, o.status, o.total_cents, o.paid_cents, o.refunded_cents, o.created_at, o.paid_at,
        s.id AS shop_id, s.name AS shop_name, s.address, m.name AS merchant_name
        FROM orders o JOIN qq_identities q ON q.customer_id = o.customer_id
        JOIN shops s ON s.id = o.shop_id JOIN merchants m ON m.id = s.merchant_id
        WHERE o.id = ? AND q.app_id = ? AND q.sender_id = ? LIMIT 1`, [orderId, identity.appId, identity.senderId], connection);
      const order = rows[0];
      if (!order) throw notFound;
      // ponytail: bounded read-only demo orders; exceed these limits only after adding pagination.
      const [items, coupons, payments, refunds] = await Promise.all([
        this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ i.id, i.product_id, p.name AS product_name,
          i.quantity, i.unit_price_cents, i.total_cents FROM order_items i JOIN products p ON p.id = i.product_id
          WHERE i.order_id = ? ORDER BY i.id LIMIT 101`, [orderId], connection),
        this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ c.id, c.order_item_id, c.status,
          c.expires_at, c.redeemed_at, c.redeemed_shop_id FROM coupons c
          JOIN order_items i ON i.id = c.order_item_id WHERE i.order_id = ? ORDER BY c.id LIMIT 101`, [orderId], connection),
        this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ status, amount_cents, paid_at
          FROM payments WHERE order_id = ? ORDER BY created_at, id LIMIT 21`, [orderId], connection),
        this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ status, amount_cents, completed_at
          FROM refunds WHERE order_id = ? ORDER BY created_at, id LIMIT 21`, [orderId], connection),
      ]);
      if (items.length > 100 || coupons.length > 100 || payments.length > 20 || refunds.length > 20) throw new Error(databaseFailure);
      const result = {
        source: "demo-database" as const, id: order.id as string, status: order.status as string,
        asOf,
        amounts: { totalCents: order.total_cents as number, paidCents: order.paid_cents as number, refundedCents: order.refunded_cents as number },
        createdAt: date(order.created_at), paidAt: date(order.paid_at),
        shop: { id: order.shop_id as string, name: order.shop_name as string, merchantName: order.merchant_name as string, address: order.address as string },
        items: items.map((item) => ({
          id: item.id as string, productId: item.product_id as string, productName: item.product_name as string,
          quantity: item.quantity as number, unitPriceCents: item.unit_price_cents as number, totalCents: item.total_cents as number,
        })),
        coupons: coupons.map((coupon) => ({
          id: coupon.id as string, orderItemId: coupon.order_item_id as string, status: coupon.status as string,
          expiresAt: date(coupon.expires_at), redeemedAt: date(coupon.redeemed_at), redeemedShopId: coupon.redeemed_shop_id as string | null,
        })),
        payments: payments.map((payment) => ({ status: payment.status as string, amountCents: payment.amount_cents as number, paidAt: date(payment.paid_at) })),
        refunds: refunds.map((refund) => ({ status: refund.status as string, amountCents: refund.amount_cents as number, completedAt: date(refund.completed_at) })),
      };
      await connection.commit();
      return result;
    } catch (error) {
      if (connection) {
        // A failed BEGIN may leave pending one-shot settings; never return that connection to the pool.
        if (!started) connection.destroy();
        else await connection.rollback().catch(() => connection!.destroy());
      }
      throw error === notFound ? notFound : new Error(databaseFailure);
    } finally { connection?.release(); }
  }

  async searchKnowledge(query: string, shopId?: string, productId?: string) {
    if (!query.trim() || query.length > 500) throw new Error("请输入 1–500 字的规则查询。");
    return rankKnowledge(query, await this.readKnowledgeDocuments(shopId, productId)).slice(0, 5).map(document => ({
      source: "demo-knowledge" as const, sourceId: document.id, title: document.title, body: document.body,
      scope: { shopId: document.shopId, productId: document.productId ?? null },
    }));
  }

  async readKnowledgeDocuments(shopId?: string, productId?: string): Promise<RetrievalDocument[]> {
    if ([shopId, productId].some((id) => id !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) || (productId && !shopId)) {
      throw new Error("请提供有效且关联的门店和套餐标识。");
    }
    if (shopId) {
      const scope = await this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ s.id FROM shops s
        WHERE s.id = ? AND s.status = 'active' AND (? IS NULL OR EXISTS (
          SELECT 1 FROM products p WHERE p.id = ? AND p.shop_id = s.id AND p.status = 'active'
        )) LIMIT 1`, [shopId, productId ?? null, productId ?? null]);
      if (!scope.length) return [];
    }
    const rows = await this.select(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ id, shop_id, product_id, title, body, tags
      FROM knowledge_documents WHERE status = 'active'
      AND (shop_id IS NULL OR shop_id = ?) AND (product_id IS NULL OR product_id = ?)
      ORDER BY id LIMIT 201`, [shopId ?? null, productId ?? null]);
    if (rows.length > 200) throw new Error(databaseFailure);
    return rows.map((row) => {
      let tags: unknown;
      try { tags = typeof row.tags === "string" ? JSON.parse(row.tags) : row.tags; } catch { throw new Error(databaseFailure); }
      if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) throw new Error(databaseFailure);
      return { id: String(row.id), tags: tags as string[], title: row.title as string, body: row.body as string,
        shopId: row.shop_id as string | null, productId: row.product_id as string | null, status: "active" as const };
    });
  }
}
