import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";
import type { ArrivalConsultationTrace } from "../src/arrival-consultation.ts";

const one: QQIdentity = { appId: "TEST_APP", senderId: "TEST_USER1" };
const two: QQIdentity = { appId: "TEST_APP", senderId: "TEST_USER2" };
const orders = "('COUPON-1001','COUPON-1002')";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Only existing synthetic records are read. Rows and trusted identity details stay in memory.
async function stateHash(pool: Pool) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const state: Record<string, unknown> = {};
    for (const table of ["orders", "order_items", "payments", "refunds", "merchant_demo_scenarios", "merchant_requests", "refund_operations"]) {
      const key = table === "orders" ? "id" : "order_id";
      const [rows] = await connection.query<RowDataPacket[]>({
        sql: `SELECT * FROM ${table} WHERE ${key} IN ${orders}`, timeout: 5000,
      });
      state[table] = rows.map(row => JSON.stringify(row)).sort();
    }
    for (const [name, sql] of [
      ["coupons", `SELECT c.* FROM coupons c JOIN order_items i ON i.id=c.order_item_id WHERE i.order_id IN ${orders}`],
      ["merchant_notifications", `SELECT n.* FROM merchant_notifications n JOIN merchant_requests m ON m.task_id=n.task_id WHERE m.order_id IN ${orders}`],
      ["identities", "SELECT * FROM qq_identities WHERE app_id='TEST_APP' AND sender_id IN ('TEST_USER1','TEST_USER2')"],
      ["customers", "SELECT * FROM customers WHERE id IN ('customer-demo-1','customer-demo-2')"],
    ]) {
      const [rows] = await connection.query<RowDataPacket[]>({ sql: sql!, timeout: 5000 });
      state[name!] = rows.map(row => JSON.stringify(row)).sort();
    }
    await connection.commit();
    return hash(state);
  } catch (error) {
    await connection.rollback().catch(() => connection.destroy());
    throw error;
  } finally { connection.release(); }
}

export async function checkArrivalConsultationDatabase() {
  let stage = "只读账户配置";
  let pool: Pool | undefined;
  const runId = randomUUID(), startedAt = new Date().toISOString();
  try {
    const config = readDatabaseConfig();
    assert.equal(config.user, "dave_agent_read", "本验收只允许项目已有只读账户");
    pool = createPool({ ...config, connectionLimit: 2 });
    const store = new CouponStore(pool);
    stage = "只读权限及合成归属前置核验";
    const [grants] = await pool.query<RowDataPacket[]>({ sql: "SHOW GRANTS FOR CURRENT_USER()", timeout: 5000 });
    const grantLines = grants.map(row => String(Object.values(row)[0]));
    assert.ok(grantLines.length > 0 && grantLines.every(line => /^GRANT (?:USAGE ON \*\.\*|SELECT ON `[^`]+`\.\*) TO /.test(line)
      && !/WITH GRANT OPTION/.test(line)), "账户必须只有 USAGE/库 SELECT 权限");
    assert.ok(grantLines.some(line => /^GRANT SELECT /.test(line)), "账户须有实际 SELECT 授权");
    const [owners] = await pool.query<RowDataPacket[]>({ sql: `SELECT o.id, o.customer_id, q.sender_id FROM orders o
      JOIN qq_identities q ON q.customer_id=o.customer_id WHERE o.id IN ${orders}
      AND q.app_id='TEST_APP' AND q.sender_id IN ('TEST_USER1','TEST_USER2') ORDER BY o.id`, timeout: 5000 });
    assert.ok(owners.length === 2 && owners[0]?.id === "COUPON-1001" && owners[0]?.customer_id === "customer-demo-1"
      && owners[0]?.sender_id === one.senderId && owners[1]?.id === "COUPON-1002" && owners[1]?.customer_id === "customer-demo-2"
      && owners[1]?.sender_id === two.senderId, "已有两份合成订单/身份归属须满足合同；不会自动重建 seed");

    stage = "前置状态快照";
    const before = await stateHash(pool);
    const { createArrivalConsultation } = await import("../src/arrival-consultation.ts");
    let reads: Array<{ identity: QQIdentity; orderId: string }> = [];
    const traces: ArrivalConsultationTrace[] = [];
    const consult = createArrivalConsultation({ getOrder: async (identity, orderId) => {
      reads.push({ identity: { ...identity }, orderId });
      return store.getOrder(identity, orderId);
    } }, { onTrace: trace => traces.push(trace) });
    let passed = 0, orderReads = 0;
    async function run(name: string, identity: QQIdentity, text: string, expectedReads: number) {
      stage = name;
      reads = [];
      const traceCount = traces.length;
      const reply = await consult(identity, text);
      assert.ok(reply, "完整到账命令必须由宿主处理");
      assert.equal(traces.length, traceCount + 1, "每轮必须留下独立宿主审计");
      const trace = traces.at(-1)!;
      assert.ok(trace.originalText === text && trace.identity.appId === identity.appId && trace.identity.senderId === identity.senderId,
        "宿主审计绑定本轮原问及可信身份");
      assert.ok(Object.values(trace.providerCalls).every(count => count === 0), "确定性咨询不得调用付费提供商");
      assert.equal(reads.length, expectedReads, "实际 getOrder 次数应符合先后重新授权合同");
      assert.ok(reads.every(read => read.identity.appId === identity.appId && read.identity.senderId === identity.senderId), "每次读取沿用当前可信身份");
      orderReads += reads.length;
      return reply;
    }
    for (const [name, identity, orderId, channel] of [
      ["第一用户本人银行卡咨询", one, "COUPON-1001", "银行卡"],
      ["第一用户本人电子钱包咨询", one, "COUPON-1001", "电子钱包"],
      ["第二用户本人银行卡咨询", two, "COUPON-1002", "银行卡"],
    ] as const) {
      const reply = await run(name, identity, `查询到账 ${orderId} ${channel}`, 2);
      assert.equal(reply.kind, "answer");
      assert.ok(reads.every(read => read.orderId === orderId), "先后读取必须是同一显式订单");
      assert.ok(reply.text.includes(orderId) && !reply.text.includes(orderId === "COUPON-1001" ? "COUPON-1002" : "COUPON-1001"), "用户结果独立且不继承另一订单");
      assert.ok(reply.text.includes(channel) && /假设/.test(reply.text) && /原创.*模拟|原创.*合成/.test(reply.text), "到账时限必须明确合成及咨询假设");
      assert.ok(reply.text.includes(channel === "银行卡" ? "3–7个工作日" : "1–3个工作日"), "本轮原创版本时限必须按所问渠道覆盖");
      assert.ok(/不等于实际支付渠道|不代表实际支付渠道|不是实际支付渠道/.test(reply.text), "用户输入的渠道不能成为数据库支付事实");
      assert.ok(/未办理|没有办理/.test(reply.text) && /不证明|不能证明|不代表/.test(reply.text), "咨询不能证明批准/发起/到账");
      assert.ok(!/79\.80|7980|paidCents|refundedCents|customer-demo|TEST_USER|TEST_APP/.test(JSON.stringify(reply)), "咨询不得带入金额/身份事实或退款许可");
      passed++;
    }
    let denial: string | undefined;
    for (const [name, identity, orderId] of [
      ["第二用户访问第一用户订单", two, "COUPON-1001"],
      ["第一用户访问第二用户订单", one, "COUPON-1002"],
      ["不存在订单", one, "COUPON-9999"],
      ["未绑定合成身份", { ...one, senderId: "TEST_UNBOUND" }, "COUPON-1001"],
      ["错误应用身份", { ...one, appId: "TEST_OTHER_APP" }, "COUPON-1001"],
    ] as const) {
      const reply = await run(name, identity, `查询到账 ${orderId} 银行卡`, 1);
      assert.equal(reply.kind, "notice");
      denial ??= JSON.stringify(reply);
      assert.equal(JSON.stringify(reply), denial, "越权/不存在/未绑定/错应用应统一拒绝");
      assert.ok(!/COUPON-|79\.80|paidCents|refundedCents|customer-demo|TEST_USER|TEST_APP/.test(JSON.stringify(reply)), "拒绝不泄露私人订单与归属");
      passed++;
    }
    for (const [name, text] of [["缺少渠道", "查询到账 COUPON-1001"], ["混合退款指令", "查询到账 COUPON-1001 银行卡 并帮我退款"]]) {
      assert.equal((await run(name!, one, text!, 0)).kind, "notice");
      passed++;
    }
    const general = await run("第二用户无订单咨询不继承历史订单", two, "查询到账 电子钱包", 0);
    assert.equal(general.kind, "answer");
    assert.ok(!/COUPON-|79\.80|paidCents|refundedCents/.test(JSON.stringify(general)), "无状态咨询不能继承上一显式订单");
    assert.equal(traces.at(-1)!.orderId, null);
    assert.ok(new Set(traces.map(trace => trace.requestId)).size === traces.length, "多用户审计请求彼此独立");
    passed++;
    stage = "后置状态快照";
    assert.equal(await stateHash(pool), before, "订单、身份、券、支付、退款及售后关联状态前后必须完全一致");
    console.log(JSON.stringify({ runId, startedAt, completedAt: new Date().toISOString(), status: "passed", cases: { planned: 11, passed },
      orderReads, database: "actual-readonly-mysql", existingSyntheticRecords: true, stateUnchanged: true,
      externalCalls: { agent: "not-called", question: "not-called", rerank: "not-called", support: "not-called", qq: "not-called" } }));
  } catch {
    console.error(`到账咨询只读 MySQL 验收未通过或环境不可用：${stage}；底层诊断已隐藏，不计通过。`);
    process.exitCode = 1;
  } finally { await pool?.end().catch(() => { process.exitCode = 1; }); }
}

// Importing this file for the zero-DB validation suite never connects to MySQL.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await checkArrivalConsultationDatabase();
