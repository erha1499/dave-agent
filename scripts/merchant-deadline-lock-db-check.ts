import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createPool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { AfterSalesStore } from "../src/after-sales.ts";
import { readDatabaseConfig } from "../src/coupon-store.ts";

const config = readDatabaseConfig();
assert.equal(config.host, "127.0.0.1");
assert.equal(config.port, 13306);
assert.equal(config.database, "dave_agent");
const nonce = randomBytes(8).toString("hex");
const database = `mdeadline${nonce}`, user = `mdeadline${nonce}`, password = randomBytes(24).toString("hex");
const taskId = randomUUID(), orderId = "COUPON-2999";
function admin(sql: string) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("专用库管理失败；未输出数据库凭据或SQL。");
  return result.stdout.trim();
}
const pool = createPool({ ...config, database, user, password, connectionLimit: 2 });
const writer = createPool({ ...config, database, user, password, connectionLimit: 1 });
const store = new AfterSalesStore(writer);
let blocker: PoolConnection | undefined;
let applying: Promise<boolean> | undefined;
let evidence: Record<string, unknown> | undefined;
const errors: unknown[] = [];
try {
  admin(`CREATE DATABASE \`${database}\`;
CREATE TABLE \`${database}\`.merchant_requests LIKE dave_agent.merchant_requests;
CREATE USER '${user}'@'%' IDENTIFIED BY '${password}';
GRANT SELECT, UPDATE ON \`${database}\`.merchant_requests TO '${user}'@'%';
INSERT INTO \`${database}\`.merchant_requests
  (task_id, order_id, customer_id, source_key, reason, amount_cents, mock_outcome, due_at, deadline_at)
VALUES ('${taskId}', '${orderId}', 'synthetic-deadline-customer', '${"a".repeat(64)}',
  '行锁跨截止合成检查', 7980, 'approve', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL 4 SECOND);`);
  const connection = await writer.getConnection();
  await connection.query("SET SESSION innodb_lock_wait_timeout = 10");
  const [details] = await connection.query<RowDataPacket[]>(
    "SELECT CONNECTION_ID() AS connection_id, VERSION() AS version, @@transaction_isolation AS isolation_level");
  connection.release();
  const connectionId = Number(details[0]!.connection_id);
  blocker = await pool.getConnection();
  const [blockingDetails] = await blocker.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS connection_id");
  const blockingId = Number(blockingDetails[0]!.connection_id);
  await blocker.beginTransaction();
  await blocker.execute("SELECT task_id FROM merchant_requests WHERE task_id = ? FOR UPDATE", [taskId]);
  const inspect = async () => {
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT deadline_at, UTC_TIMESTAMP(3) AS observed_at,
      deadline_at > UTC_TIMESTAMP(3) AS before_deadline,
      UTC_TIMESTAMP(3) >= deadline_at + INTERVAL 300000 MICROSECOND AS after_margin
      FROM merchant_requests WHERE task_id = ?`, [taskId]);
    return rows[0]!;
  };
  assert.equal((await inspect()).before_deadline, 1, "setup must finish before deadline");
  applying = store.applyResult({ taskId, orderId, status: "approved", approvedAmountCents: 7980 });
  applying.catch(() => {}); // Await again after unlocking, including on a failed synchronization check.
  let waitingAt: Date | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    const waiting = admin(`SELECT COUNT(*) FROM performance_schema.data_lock_waits w
      JOIN performance_schema.threads r ON r.THREAD_ID = w.REQUESTING_THREAD_ID
      JOIN performance_schema.threads b ON b.THREAD_ID = w.BLOCKING_THREAD_ID
      WHERE r.PROCESSLIST_ID = ${connectionId} AND b.PROCESSLIST_ID = ${blockingId};`);
    const observation = await inspect();
    assert.equal(observation.before_deadline, 1, "must observe actual lock wait before deadline");
    if (waiting === "1") { waitingAt = observation.observed_at as Date; break; }
    await sleep(25);
  }
  assert.ok(waitingAt, "server must confirm the formal Store connection is waiting");
  let releasedAfter: RowDataPacket | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    const observation = await inspect();
    if (observation.after_margin) { releasedAfter = observation; break; }
    await sleep(50);
  }
  assert.ok(releasedAfter, "release only after the database deadline plus 300ms");
  await blocker.commit();
  const accepted = await applying;
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT status, approved_amount_cents, completed_at,
    completed_at < deadline_at AS completion_field_before_deadline, UTC_TIMESTAMP(3) AS returned_at
    FROM merchant_requests WHERE task_id = ?`, [taskId]);
  const final = rows[0]!;
  assert.equal(accepted, false, "a lock wait crossing the deadline must not authorize a result");
  assert.equal(final.status, "pending");
  assert.equal(final.approved_amount_cents, null);
  assert.equal(final.completed_at, null);
  const source = await readFile(new URL("../src/after-sales.ts", import.meta.url));
  evidence = { check: "merchant-deadline-lock-regression-v2", version: details[0]!.version,
    isolation: details[0]!.isolation_level, sourceSha256: createHash("sha256").update(source).digest("hex"),
    deadlineAt: releasedAfter.deadline_at, waitingObservedAt: waitingAt,
    lockReleaseLowerBound: releasedAfter.observed_at, accepted, status: final.status,
    completedAt: final.completed_at, completionFieldBeforeDeadline: Boolean(final.completion_field_before_deadline),
    returnedAt: final.returned_at };
  // Reuse the same isolated row; no global worker scan or business database writes.
  const callback = { taskId, orderId, status: "approved" as const, approvedAmountCents: 7980 };
  admin(`UPDATE \`${database}\`.merchant_requests SET deadline_at = UTC_TIMESTAMP(3) + INTERVAL 8 SECOND WHERE task_id = '${taskId}';`);
  assert.equal(await store.applyResult({ ...callback, taskId: randomUUID() }), false);
  assert.equal(await store.applyResult({ ...callback, orderId: "COUPON-2998" }), false);
  assert.equal(await store.applyResult({ ...callback, approvedAmountCents: 7981 }), false);
  assert.equal(await store.applyResult(callback), true);
  assert.equal(await store.applyResult(callback), false);
  assert.equal(await store.applyResult({ ...callback, status: "rejected", approvedAmountCents: null }), false);
  admin(`UPDATE \`${database}\`.merchant_requests SET status = 'pending', approved_amount_cents = NULL,
    completed_at = NULL, deadline_at = UTC_TIMESTAMP(3) + INTERVAL 8 SECOND WHERE task_id = '${taskId}';`);
  assert.equal(await store.applyResult({ ...callback, status: "rejected", approvedAmountCents: null }), true);
  assert.equal(await store.applyResult(callback), false);
  const [rejected] = await pool.execute<RowDataPacket[]>("SELECT status, approved_amount_cents, completed_at FROM merchant_requests WHERE task_id = ?", [taskId]);
  assert.equal(rejected[0]!.status, "rejected");
  assert.equal(rejected[0]!.approved_amount_cents, null);
  assert.ok(rejected[0]!.completed_at);
  evidence.normalAndBoundaryChecks = 8;
} catch (error) { errors.push(error); } finally {
  const rolledBack = await Promise.allSettled([blocker?.rollback()]);
  blocker?.release();
  await applying?.catch(error => { errors.push(error); });
  const closed = await Promise.allSettled([store.close(), pool.end()]);
  try { admin(`DROP DATABASE IF EXISTS \`${database}\`; DROP USER IF EXISTS '${user}'@'%';`); }
  catch { errors.push(new Error(`专用库清理失败；检查残留库/账号 ${database}（主业务库未写入）。`)); }
  for (const result of [...rolledBack, ...closed]) if (result.status === "rejected") errors.push(result.reason);
}
if (errors.length) throw new AggregateError([...new Set(errors)], "截止复现或清理失败，保留全部异常。");
console.log(JSON.stringify({ ...evidence, cleaned: true }));
