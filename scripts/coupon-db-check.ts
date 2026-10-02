import assert from "node:assert/strict";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";

const config = readDatabaseConfig({ DB_PASSWORD: "synthetic-local-password" });
assert.equal(config.host, "127.0.0.1");
assert.equal(config.port, 13306);
assert.equal(config.database, "dave_agent");
assert.equal(config.user, "dave_agent_read");
assert.equal(config.multipleStatements, false);
assert.throws(() => readDatabaseConfig({}), /DB_PASSWORD/);
assert.throws(() => readDatabaseConfig({ DB_PASSWORD: "test", DB_PORT: "13306; DROP TABLE orders" }), /DB_PORT/);
assert.throws(() => readDatabaseConfig({ DB_PASSWORD: "test", DB_HOST: "localhost/other" }), /DB_HOST/);
assert.throws(() => readDatabaseConfig({ DB_PASSWORD: "test", DB_USER: "user;root" }), /DB_NAME 或 DB_USER/);

const pool = createPool(readDatabaseConfig());
const store = new CouponStore(pool);
const one: QQIdentity = { appId: "TEST_APP", senderId: "TEST_USER1" };
const two: QQIdentity = { appId: "TEST_APP", senderId: "TEST_USER2" };
const denied = "未找到当前客户可查询的订单，请核对订单号或联系人工客服。";
try {
  await store.ping();
  const [tables] = await pool.execute<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  for (const name of ["customers", "qq_identities", "merchants", "shops", "products", "orders", "order_items", "coupons", "payments", "refunds", "knowledge_documents"]) {
    assert.ok(tables.some((table) => table.name === name), `missing relational table: ${name}`);
  }
  assert.equal(await store.resolveCustomer(one), "customer-demo-1");
  assert.equal(await store.resolveCustomer(two), "customer-demo-2");
  assert.equal(await store.resolveCustomer({ ...one, appId: "OTHER_APP" }), undefined);

  const unused = await store.getOrder(one, "COUPON-1001");
  assert.equal(unused.id, "COUPON-1001");
  assert.equal(unused.source, "demo-database");
  assert.equal(unused.status, "paid");
  assert.deepEqual(unused.amounts, { totalCents: 7980, paidCents: 7980, refundedCents: 0 });
  assert.equal(unused.shop.id, "shop-demo-1");
  assert.equal(unused.items[0]?.productId, "product-demo-1");
  assert.equal(unused.items[0]?.totalCents, 7980);
  assert.equal(unused.coupons[0]?.orderItemId, unused.items[0]?.id);
  assert.equal(unused.coupons[0]?.status, "unused");
  assert.ok(Date.parse(unused.coupons[0]!.expiresAt!) > Date.parse(unused.asOf));
  assert.equal(unused.payments[0]?.status, "succeeded");
  assert.equal(unused.payments[0]?.amountCents, unused.amounts.paidCents);
  assert.deepEqual(unused.refunds, []);
  assert.ok(!/customer_id|customerId|display_name|TEST_USER|TEST_APP|tracking|payment-1001/.test(JSON.stringify(unused)));

  await assert.rejects(store.getOrder(one, "COUPON-1002"), { message: denied });
  await assert.rejects(store.getOrder(one, "COUPON-9999"), { message: denied });
  await assert.rejects(store.getOrder({ ...one, senderId: "UNBOUND_USER" }, "COUPON-1001"), { message: denied });
  await assert.rejects(store.getOrder({ ...one, appId: "OTHER_APP" }, "COUPON-1001"), { message: denied });
  await assert.rejects(store.getOrder({ ...one, senderId: "TEST_USER1' OR 1=1 --" }, "COUPON-1001"), { message: denied });
  await assert.rejects(store.getOrder(one, "COUPON-1001' OR 1=1 --"), /订单号格式/);
  assert.equal((await store.getOrder(two, "COUPON-1002")).status, "paid");
  await assert.rejects(store.getOrder(two, "COUPON-1001"), { message: denied });

  const expired = await store.getOrder(one, "COUPON-1003");
  assert.equal(expired.coupons[0]?.status, "expired");
  assert.ok(Date.parse(expired.coupons[0]!.expiresAt!) < Date.parse(expired.asOf));
  const refunded = await store.getOrder(one, "COUPON-1004");
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.amounts.refundedCents, 5990);
  assert.deepEqual(refunded.refunds.map(({ status, amountCents }) => ({ status, amountCents })), [{ status: "succeeded", amountCents: 5990 }]);
  const partial = await store.getOrder(one, "COUPON-1005");
  assert.equal(partial.status, "partially_redeemed");
  assert.equal(partial.amounts.paidCents, 11980);
  assert.equal(partial.items[0]?.quantity, 2);
  assert.equal(partial.items[0]?.unitPriceCents, 5990);
  assert.deepEqual(partial.coupons.map(({ status }) => status).sort(), ["redeemed", "unused"]);
  const unpaid = await store.getOrder(one, "COUPON-1006");
  assert.equal(unpaid.status, "pending_payment");
  assert.equal(unpaid.amounts.paidCents, 0);
  assert.equal(unpaid.paidAt, null);
  assert.deepEqual(unpaid.coupons, []);
  assert.equal(unpaid.payments[0]?.status, "pending");
  const redeemed = await store.getOrder(one, "COUPON-1007");
  assert.equal(redeemed.status, "redeemed");
  assert.equal(redeemed.coupons[0]?.status, "redeemed");
  assert.equal(redeemed.coupons[0]?.redeemedShopId, redeemed.shop.id);
  assert.ok(redeemed.coupons[0]?.redeemedAt);
  const unknown = await store.getOrder(one, "COUPON-1008");
  assert.equal(unknown.items[0]?.productId, "product-demo-3");
  for (const order of [unused, expired, refunded, partial, unpaid, redeemed, unknown]) {
    for (const amount of Object.values(order.amounts)) assert.ok(Number.isSafeInteger(amount) && amount >= 0);
    assert.equal(order.items.reduce((sum, item) => sum + item.totalCents, 0), order.amounts.totalCents);
  }

  const publicRules = await store.searchKnowledge("我那个还没用的能退不");
  assert.ok(publicRules.some((rule) => rule.sourceId === "KB-REFUND-UNUSED"));
  assert.ok(publicRules.every((rule) => rule.scope.shopId === null && rule.scope.productId === null));
  const lunch = await store.searchKnowledge("双人午餐套餐价格", "shop-demo-1", "product-demo-1");
  assert.ok(lunch.some((rule) => rule.sourceId === "KB-PRODUCT-LUNCH"));
  assert.ok(!lunch.some((rule) => rule.sourceId === "KB-PRODUCT-DINNER"));
  const privateHoliday = await store.searchKnowledge("私享套餐五一能用吗", "shop-demo-1", "product-demo-3");
  assert.ok(privateHoliday.some((rule) => rule.sourceId === "KB-SHOP-DEMO-1" && rule.body.includes("没有录入")));
  assert.ok(privateHoliday.every((rule) => !["KB-PRODUCT-LUNCH", "KB-PRODUCT-DINNER"].includes(rule.sourceId)));
  assert.deepEqual(await store.searchKnowledge("演示餐厅停车费是多少"), []);
  assert.deepEqual(await store.searchKnowledge("周末预约", "shop-unknown"), []);
  assert.deepEqual(await store.searchKnowledge("退款", "shop-unknown", "product-unknown"), []);
  assert.deepEqual(await store.searchKnowledge("退款", "shop-demo-1", "product-unknown"), []);
  assert.deepEqual(await store.searchKnowledge("退款", "shop-unknown", "product-demo-1"), []);
  await assert.rejects(store.searchKnowledge(" "), /规则查询/);
  await assert.rejects(store.searchKnowledge("x".repeat(501)), /规则查询/);
  await assert.rejects(store.searchKnowledge("套餐", undefined, "product-demo-1"), /门店和套餐/);
  await assert.rejects(store.searchKnowledge("套餐", "shop-demo-1' OR 1=1 --"), /门店和套餐/);
  const [documents] = await pool.execute<RowDataPacket[]>("SELECT id, shop_id, product_id, status FROM knowledge_documents");
  for (const rule of [...publicRules, ...lunch, ...privateHoliday]) {
    const document = documents.find((item) => item.id === rule.sourceId);
    assert.ok(document && document.status === "active");
    assert.equal(rule.scope.shopId, document.shop_id);
    assert.equal(rule.scope.productId, document.product_id);
  }
  // WHERE 1=0 guarantees no mutation even if someone mistakenly gives this user write privileges.
  await assert.rejects(pool.execute("UPDATE orders SET status = status WHERE 1 = 0"), (error: unknown) =>
    !!error && typeof error === "object" && "code" in error && error.code === "ER_TABLEACCESS_DENIED_ERROR");
  console.log("真实 MySQL 检查通过：11 表关联、8 种订单、整数金额、本人归属/AppID 隔离、规则作用域/证据、未知规则、只读权限与注入拒绝。");
} finally {
  await store.close();
}
