import assert from "node:assert/strict";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { CouponStore, OrderAccessError, readDatabaseConfig } from "../src/coupon-store.ts";

const config = readDatabaseConfig();
assert.ok(["127.0.0.1", "localhost"].includes(String(config.host)) && config.port === 13306 && config.database === "dave_agent"
  && config.user === "dave_agent_read", "只允许本机合成订单数据库的只读账户。");
const pool = createPool(config), store = new CouponStore(pool);
try {
  await store.ping();
  const results: Array<Awaited<ReturnType<CouponStore["listOrders"]>>> = [];
  for (const senderId of ["TEST_USER1", "TEST_USER2"]) {
    const identity = { appId: "TEST_APP", senderId };
    const list = await store.listOrders(identity);
    const [expected] = await pool.execute<RowDataPacket[]>(`SELECT o.id FROM orders o JOIN qq_identities q ON q.customer_id = o.customer_id
      WHERE q.app_id = ? AND q.sender_id = ? ORDER BY o.created_at DESC, o.id DESC LIMIT 4`, [identity.appId, identity.senderId]);
    assert.deepEqual(list.orders.map(order => order.id), expected.slice(0, 3).map(order => order.id));
    assert.equal(list.hasMore, expected.length > 3); assert.equal(list.source, "demo-database");
    assert.ok(!/customer_id|customerId|senderId|appId|TEST_USER|TEST_APP/.test(JSON.stringify(list)));
    for (const summary of list.orders) {
      const fresh = await store.getOrder(identity, summary.id);
      assert.equal(summary.status, fresh.status); assert.equal(summary.paidCents, fresh.amounts.paidCents);
      assert.equal(summary.refundedCents, fresh.amounts.refundedCents); assert.equal(summary.createdAt, fresh.createdAt);
      assert.equal(summary.shopName, fresh.shop.name); assert.ok(summary.productName.startsWith(fresh.items[0]?.productName ?? "订单商品"));
      assert.deepEqual([...summary.couponStatuses].sort(), fresh.coupons.map(coupon => coupon.status).sort());
    }
    results.push(list);
  }
  assert.ok(results[0]!.orders.every(order => !results[1]!.orders.some(other => other.id === order.id)));
  for (const identity of [{ appId: "OTHER_APP", senderId: "TEST_USER1" }, { appId: "TEST_APP", senderId: "UNBOUND_USER" }, { appId: "TEST_APP", senderId: "' OR 1=1 --" }]) {
    await assert.rejects(store.listOrders(identity), OrderAccessError);
  }
  console.log("最近订单真实 MySQL 专项通过：双身份隔离、下单时间/订单号排序、最近三笔与更多提示、摘要与重新授权详情一致、未绑定/AppID/注入拒绝；未修改数据。");
} finally { await store.close(); }
