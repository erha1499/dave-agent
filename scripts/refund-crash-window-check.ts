import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from "mysql2/promise";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig } from "../src/after-sales.ts";
import { CouponStore, readDatabaseConfig, type QQIdentity } from "../src/coupon-store.ts";
import { RefundStore, readRefundDatabaseConfig } from "../src/refunds.ts";
import { confirmRefundReply, markRefundReplyPresented } from "../src/refund-entry.ts";
import { renderReply } from "../src/reply.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";

type Window = "before-commit" | "after-commit";
type Input = { nonce: string; window: Window; orderId: string; operationId?: string };
type Snapshot = Record<string, Array<Record<string, unknown>>>;
type Packet = { kind: "result" | "barrier" | "failure"; pid: number; nonce: string; window: Window; data: Record<string, unknown> };
type Exit = { code: number | null; signal: NodeJS.Signals | null };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const identity: QQIdentity = { appId: "TEST_APP", senderId: "TEST_USER1" };
const windows: Window[] = ["before-commit", "after-commit"];
const root = fileURLToPath(new URL("../", import.meta.url));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const source = (input: Input) => merchantSourceKey(identity, `refund-crash-${input.nonce}`);
const changedTables = ["orders", "coupons", "operations", "refunds"];
const queries: Record<string, string> = {
  orders: "SELECT * FROM orders WHERE id=?", items: "SELECT * FROM order_items WHERE order_id=? ORDER BY id",
  coupons: "SELECT c.* FROM coupons c JOIN order_items i ON i.id=c.order_item_id WHERE i.order_id=? ORDER BY c.id",
  payments: "SELECT * FROM payments WHERE order_id=? ORDER BY id", tasks: "SELECT * FROM merchant_requests WHERE order_id=? ORDER BY task_id",
  operations: "SELECT * FROM refund_operations WHERE order_id=? ORDER BY operation_id", refunds: "SELECT * FROM refunds WHERE order_id=? ORDER BY id",
  notifications: "SELECT n.* FROM merchant_notifications n JOIN merchant_requests r ON r.task_id=n.task_id WHERE r.order_id=? ORDER BY n.task_id",
  scenarios: "SELECT * FROM merchant_demo_scenarios WHERE order_id=?",
};
function validateInput(input: Input) {
  assert.deepEqual(Object.keys(input).sort(), (input.operationId === undefined ? ["nonce", "orderId", "window"] : ["nonce", "operationId", "orderId", "window"]).sort());
  assert.match(input.nonce, uuid); assert.ok(windows.includes(input.window)); assert.match(input.orderId, /^COUPON-2[1-9]\d{2}$/);
  if (input.operationId !== undefined) assert.match(input.operationId, uuid);
}
function localConfig() {
  const configs = [readDatabaseConfig(), readAfterSalesDatabaseConfig(), readRefundDatabaseConfig()];
  for (const config of configs) assert.ok(["localhost", "127.0.0.1"].includes(String(config.host))
    && Number(config.port) === 13306 && config.database === "dave_agent", "Only local Docker :13306/dave_agent is allowed");
  return configs;
}
function errorInfo(error: unknown) {
  // Never serialize connection options, driver SQL or credentials into reports.
  return { name: error instanceof Error ? error.name : "Error", code: error && typeof error === "object" && "code" in error
    && /^[A-Z0-9_]+$/.test(String(error.code)) ? String(error.code) : undefined,
  message: error instanceof assert.AssertionError || error instanceof HarnessError ? error.message.slice(0, 700) : "Operation failed; inspect the named stage locally." };
}
class HarnessError extends Error {}
async function bounded<T>(action: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([action, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HarnessError(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function rows(connection: PoolConnection, orderId: string, tables = Object.keys(queries)): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const name of tables) {
    const [value] = await connection.query<RowDataPacket[]>({ sql: queries[name]!, timeout: 5000 }, [orderId]);
    // IPC and parent snapshots use identical Date/string serialization.
    result[name] = JSON.parse(JSON.stringify(value)) as Snapshot[string];
  }
  return result;
}
async function snapshot(pool: Pool, orderId: string): Promise<Snapshot> {
  const connection = await pool.getConnection();
  try {
    await connection.query({ sql: "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", timeout: 5000 });
    await connection.query({ sql: "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", timeout: 5000 });
    const value = await rows(connection, orderId);
    await connection.query({ sql: "COMMIT", timeout: 5000 }); return value;
  } catch (error) { connection.destroy(); throw error; }
  finally { connection.release(); }
}
function verifySnapshot(db: Snapshot, input: Input, status: "awaiting_confirmation" | "succeeded") {
  for (const table of ["orders", "items", "coupons", "payments", "tasks", "operations", "scenarios"]) assert.equal(db[table]?.length, 1, `${table}: one owned fixture row`);
  assert.equal(db.notifications?.length, 0, "No notification route or dispatch in this check");
  const order = db.orders![0]!, operation = db.operations![0]!, task = db.tasks![0]!;
  assert.equal(order.id, input.orderId); assert.equal(order.paid_cents, 7980); assert.equal(order.total_cents, 7980);
  assert.equal(operation.operation_id, input.operationId); assert.equal(operation.order_id, input.orderId); assert.equal(operation.status, status);
  assert.equal(operation.amount_cents, order.paid_cents); assert.equal(operation.customer_id, order.customer_id);
  assert.equal(operation.app_id, identity.appId); assert.equal(operation.sender_id, identity.senderId); assert.equal(operation.source_key, source(input));
  assert.ok(operation.presented_at); assert.equal(task.task_id, operation.task_id); assert.equal(task.order_id, input.orderId);
  assert.equal(task.customer_id, order.customer_id); assert.equal(task.source_key, source(input)); assert.equal(task.status, "approved");
  assert.equal(task.amount_cents, 7980); assert.equal(task.approved_amount_cents, 7980);
  assert.equal(db.items![0]!.order_id, input.orderId); assert.equal(db.coupons![0]!.order_item_id, db.items![0]!.id);
  assert.equal(db.payments![0]!.order_id, input.orderId); assert.equal(db.payments![0]!.amount_cents, 7980); assert.equal(db.payments![0]!.status, "succeeded");
  assert.equal(db.scenarios![0]!.order_id, input.orderId);
  if (status === "awaiting_confirmation") {
    assert.equal(order.status, "paid"); assert.equal(order.refunded_cents, 0); assert.equal(db.coupons![0]!.status, "unused");
    assert.equal(db.refunds?.length, 0); assert.equal(operation.refund_id, null); assert.equal(operation.confirmed_at, null);
  } else {
    assert.equal(order.status, "refunded"); assert.equal(order.refunded_cents, 7980); assert.equal(db.coupons![0]!.status, "refunded");
    assert.equal(db.refunds?.length, 1); const refund = db.refunds![0]!;
    assert.equal(refund.id, operation.refund_id); assert.equal(refund.order_id, input.orderId); assert.equal(refund.status, "succeeded");
    assert.equal(refund.amount_cents, 7980); assert.ok(operation.confirmed_at); assert.equal(refund.completed_at, operation.confirmed_at);
  }
}
function verifyUnchanged(baseline: Snapshot, current: Snapshot) {
  for (const name of Object.keys(queries).filter(name => !changedTables.includes(name))) assert.deepEqual(current[name], baseline[name], `${name} must remain unchanged`);
  const without = (row: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));
  for (const [name, keys] of [["orders", ["status", "refunded_cents"]], ["coupons", ["status"]],
    ["operations", ["status", "confirmed_at", "refund_id"]]] as const) {
    assert.deepEqual(without(current[name]![0]!, [...keys]), without(baseline[name]![0]!, [...keys]), `${name}: no unrelated field changes`);
  }
}

// Only a child-local connection is wrapped. No production hooks, SQL changes or timed sleeps.
function commitBarrier(nativeCommit: () => Promise<void>, window: Window, pause: () => Promise<never>) {
  return async () => { if (window === "before-commit") await pause(); await nativeCommit(); await pause(); };
}
function send(input: Input, kind: Packet["kind"], data: Packet["data"]) {
  assert.ok(process.send, "Private child mode requires an owned IPC channel");
  process.send({ kind, pid: process.pid, nonce: input.nonce, window: input.window, data } satisfies Packet);
}
function pauseAtBarrier(input: Input, data: Packet["data"]): Promise<never> {
  send(input, "barrier", data); return new Promise(() => {});
}
async function databaseChild(mode: string, input: Input) {
  const configs = localConfig(), readPool = createPool(configs[0]!), merchant = new AfterSalesStore(createPool(configs[1]!));
  const refundPool = createPool(configs[2]!), refunds = new RefundStore(refundPool), business = new CouponStore(createPool(configs[0]!));
  const sourceKey = source(input);
  try {
    if (mode === "prepare") {
      assert.equal(input.operationId, undefined);
      const task = await merchant.request(identity, sourceKey, input.orderId, "提交边界受控中断检查");
      assert.equal(await merchant.applyResult({ taskId: task.taskId, orderId: input.orderId, status: "approved", approvedAmountCents: task.amountCents }), true);
      const operation = await refunds.prepare(identity, sourceKey, input.orderId);
      const reply = { kind: "refund_confirmation", operation } as const, displayed = renderReply(reply);
      assert.equal(displayed.button?.command, `确认退款 ${operation.operationId}`);
      assert.ok(displayed.text.split("\n").includes(displayed.button!.command));
      // Local successful delivery sink only; this is not a QQ transport assertion.
      const delivered = [displayed]; assert.equal(delivered.length, 1);
      await markRefundReplyPresented(refunds, identity, sourceKey, reply);
      send(input, "result", { operationId: operation.operationId, localDeliveries: delivered.length }); return;
    }
    assert.ok(input.operationId);
    const command = `确认退款 ${input.operationId}`;
    if (mode === "crash") {
      const acquire = refundPool.getConnection.bind(refundPool);
      refundPool.getConnection = async () => {
        const connection = await acquire(), nativeCommit = connection.commit.bind(connection);
        connection.commit = commitBarrier(nativeCommit, input.window, async () => {
          // The four writes have actually executed; the marker cannot be sent from an earlier fake phase.
          const writes = await rows(connection, input.orderId, changedTables);
          assert.equal(writes.orders![0]!.status, "refunded"); assert.equal(writes.orders![0]!.refunded_cents, 7980);
          assert.equal(writes.coupons![0]!.status, "refunded"); assert.equal(writes.operations![0]!.status, "succeeded");
          assert.equal(writes.operations![0]!.operation_id, input.operationId); assert.equal(writes.refunds!.length, 1);
          assert.equal(writes.refunds![0]!.id, writes.operations![0]!.refund_id);
          return pauseAtBarrier(input, { operationId: input.operationId, writesHash: hash(writes), nativeCommitReturned: input.window === "after-commit" });
        });
        return connection;
      };
      await confirmRefundReply(refunds, identity, sourceKey, command);
      throw new HarnessError("Confirmation returned before the controlled crash; no lost-receipt evidence");
    }
    assert.equal(mode, "recover");
    const before = await snapshot(readPool, input.orderId);
    verifySnapshot(before, input, input.window === "before-commit" ? "awaiting_confirmation" : "succeeded");
    const order = await business.getOrder(identity, input.orderId), operation = await refunds.get(identity, sourceKey, input.orderId);
    assert.equal(order.id, input.orderId); assert.equal(order.status, before.orders![0]!.status);
    assert.equal(order.amounts.refundedCents, before.orders![0]!.refunded_cents); assert.equal(operation?.operationId, input.operationId);
    assert.equal(operation?.status, before.operations![0]!.status); assert.equal(operation?.refundId, before.operations![0]!.refund_id);
    const queried = await snapshot(readPool, input.orderId); assert.deepEqual(queried, before, "Recovery queries cannot write");
    const wrongIdentity = { ...identity, senderId: "TEST_USER2" }, wrongSource = merchantSourceKey(identity, `wrong-${input.nonce}`);
    await assert.rejects(business.getOrder(wrongIdentity, input.orderId));
    for (const [who, key] of [[wrongIdentity, sourceKey], [identity, wrongSource]] as const) {
      assert.equal(await refunds.get(who, key, input.orderId), undefined);
      assert.equal((await confirmRefundReply(refunds, who, key, command))?.kind, "notice");
    }
    const denied = await snapshot(readPool, input.orderId); assert.deepEqual(denied, before, "Unauthorized query/confirmation cannot write");
    const receipt = await confirmRefundReply(refunds, identity, sourceKey, command); assert.equal(receipt?.kind, "refund_status");
    assert.ok(receipt?.kind === "refund_status"); assert.equal(receipt.operation.operationId, input.operationId);
    const completed = await snapshot(readPool, input.orderId); verifySnapshot(completed, input, "succeeded"); verifyUnchanged(before, completed);
    assert.equal(receipt.operation.refundId, completed.refunds![0]!.id);
    assert.deepEqual(await confirmRefundReply(refunds, identity, sourceKey, command), receipt);
    const duplicate = await snapshot(readPool, input.orderId); assert.deepEqual(duplicate, completed, "Duplicate confirmation cannot add a refund or change its timestamps");
    if (input.window === "after-commit") assert.deepEqual(completed, before, "Lost receipt recovers the original durable result");
    send(input, "result", { operationId: input.operationId, refundId: receipt.operation.refundId,
      beforeHash: hash(before), queriedHash: hash(queried), deniedHash: hash(denied), completedHash: hash(completed), duplicateHash: hash(duplicate),
      queryStatus: operation!.status, wrongIdentityDenied: true, wrongSourceDenied: true, duplicateSameReceipt: true });
  } finally { await Promise.all([readPool.end(), merchant.close(), refunds.close(), business.close()]); }
}

class Children {
  private active = new Map<ChildProcess, Promise<Exit>>();
  private stopping = false;
  async stopAll() {
    this.stopping = true;
    const stopped = await Promise.allSettled([...this.active].map(async ([child, exit]) => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await bounded(exit, 5000, "Owned child shutdown did not exit within 5 seconds");
    }));
    const errors = stopped.filter(result => result.status === "rejected");
    if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Owned child shutdown failed");
  }
  async run(mode: string, input: Input, options: { milliseconds?: number; barrier?: (packet: Packet) => Promise<void> } = {}) {
    if (this.stopping) throw new HarnessError("Child coordinator is stopped");
    validateInput(input);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), `--child=${mode}`], { cwd: root, env: process.env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    let exited = false, timedOut = false, received = false, spawnError: unknown, protocolError: Error | undefined;
    const exit = new Promise<Exit>(resolve => child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); }));
    this.active.set(child, exit);
    // Drain child output without printing driver errors or retaining unbounded buffers.
    child.stdout!.resume(); child.stderr!.resume(); child.stdin!.on("error", () => {});
    let rejectPacket: (error: Error) => void = () => {};
    const packet = new Promise<Packet>((resolve, reject) => {
      rejectPacket = reject;
      child.once("error", error => { spawnError = error; this.active.delete(child); reject(new HarnessError("Owned child failed to spawn")); });
      child.on("message", value => {
        if (received) { protocolError = new HarnessError("Unexpected duplicate child packet"); reject(protocolError); return; }
        received = true;
        try {
          assert.ok(value && typeof value === "object"); const result = value as Packet;
          assert.deepEqual(Object.keys(result).sort(), ["data", "kind", "nonce", "pid", "window"]);
          assert.equal(result.pid, child.pid, "Marker must belong to the child spawned here"); assert.equal(result.nonce, input.nonce);
          assert.equal(result.window, input.window); assert.ok(result.data && typeof result.data === "object" && !Array.isArray(result.data));
          assert.ok(["result", "barrier", "failure"].includes(result.kind));
          if (result.kind === "failure") throw new HarnessError(`Child stage ${mode} failed: ${JSON.stringify(result.data)}`);
          resolve(result);
        } catch (error) { reject(error); }
      });
      child.once("exit", () => { if (!received) reject(new HarnessError("Owned child exited before its expected packet")); });
    });
    const timer = setTimeout(() => { timedOut = true; rejectPacket(new HarnessError(`Owned child ${mode} exceeded its deadline`));
      if (!exited) child.kill("SIGKILL"); }, options.milliseconds ?? 30_000);
    try {
      child.stdin!.end(JSON.stringify(input)); const value = await packet;
      if (options.barrier) {
        assert.equal(value.kind, "barrier"); await options.barrier(value);
        assert.equal(timedOut, false, "Deadline kill is a failure, never a successful controlled crash");
        assert.equal(exited, false, "Child must still be paused before the deliberate kill");
        assert.equal(child.kill("SIGKILL"), true, "Signal only the exact owned ChildProcess");
      } else assert.equal(value.kind, "result");
      const ended = await bounded(exit, 5000, "Owned child did not exit within 5 seconds");
      assert.equal(protocolError, undefined); assert.equal(timedOut, false);
      assert.deepEqual(ended, options.barrier ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null });
      return { pid: child.pid!, data: value.data, exit: ended };
    } finally {
      clearTimeout(timer);
      if (!exited && !spawnError) { child.kill("SIGKILL"); await bounded(exit, 5000, "Failed child cleanup: exit not observed"); }
      this.active.delete(child);
    }
  }
}

export async function checkRefundCrashWindowsDatabase() {
  const nonce = randomUUID(), children = new Children();
  const report = { suite: "refund-crash-windows", nonce, planned: 2, remoteRequests: 0, modelCalls: 0, qqCalls: 0,
    windows: windows.map(window => ({ window, status: "not_run", stage: "preflight", evidence: {} as Record<string, unknown> })),
    cleanup: { status: "not_needed", remaining: {} as Record<string, unknown> }, errors: [] as Array<Record<string, unknown>> };
  let fixture: Awaited<ReturnType<typeof createMerchantFixture>> | undefined, pool: Pool | undefined, interrupted = false;
  const onSignal = () => { interrupted = true; void children.stopAll().catch(() => {}); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  console.log(JSON.stringify({ event: "run_started", suite: report.suite, nonce, plannedWindows: windows, mode: "db" }));
  try {
    const configs = localConfig(); fixture = await createMerchantFixture(["approve", "approve"], { delayMs: 5000 });
    pool = createPool(configs[0]!); report.cleanup.status = "pending";
    console.log(JSON.stringify({ event: "fixture_allocated", nonce, orders: fixture.orders }));
    for (const [index, result] of report.windows.entries()) {
      if (interrupted) { result.stage = "interrupted"; continue; }
      const input: Input = { nonce, window: result.window, orderId: fixture.orders[index]! };
      result.evidence = { orderId: input.orderId };
      try {
        result.stage = "prepare"; const prepared = await children.run("prepare", input);
        input.operationId = String(prepared.data.operationId); validateInput(input);
        const baseline = await snapshot(pool, input.orderId); verifySnapshot(baseline, input, "awaiting_confirmation");
        assert.match(String(baseline.payments![0]!.id), /^mcheck-[a-f0-9]{20}-payment-2[1-9]\d{2}$/);
        result.evidence = { orderId: input.orderId, operationId: input.operationId, fixturePaymentMarker: baseline.payments![0]!.id,
          baselineHash: hash(baseline), preparePid: prepared.pid };
        console.log(JSON.stringify({ event: "prepared", nonce, window: input.window, ...result.evidence }));
        let visible!: Snapshot;
        result.stage = "commit_barrier";
        const crashed = await children.run("crash", input, { barrier: async packet => {
          assert.equal(packet.data.operationId, input.operationId); assert.equal(packet.data.nativeCommitReturned, input.window === "after-commit");
          assert.match(String(packet.data.writesHash), /^[a-f0-9]{64}$/);
          visible = await snapshot(pool!, input.orderId);
          if (input.window === "before-commit") assert.deepEqual(visible, baseline, "Uncommitted writes are invisible to another connection");
          else {
            verifySnapshot(visible, input, "succeeded"); verifyUnchanged(baseline, visible);
            assert.equal(hash(Object.fromEntries(changedTables.map(name => [name, visible[name]]))), packet.data.writesHash);
          }
          Object.assign(result.evidence, { barrierWritesHash: packet.data.writesHash, visibleWhilePausedHash: hash(visible) });
        } });
        result.stage = "after_exit";
        const afterExit = await snapshot(pool, input.orderId);
        verifySnapshot(afterExit, input, input.window === "before-commit" ? "awaiting_confirmation" : "succeeded");
        assert.deepEqual(afterExit, input.window === "before-commit" ? baseline : visible);
        result.stage = "fresh_process_recovery"; const recovered = await children.run("recover", input);
        assert.notEqual(recovered.pid, crashed.pid); assert.notEqual(recovered.pid, prepared.pid);
        assert.equal(recovered.data.beforeHash, hash(afterExit)); assert.equal(recovered.data.queriedHash, hash(afterExit));
        assert.equal(recovered.data.deniedHash, hash(afterExit)); assert.equal(recovered.data.duplicateHash, recovered.data.completedHash);
        assert.equal(recovered.data.operationId, input.operationId); assert.equal(recovered.data.wrongIdentityDenied, true);
        assert.equal(recovered.data.wrongSourceDenied, true); assert.equal(recovered.data.duplicateSameReceipt, true);
        const final = await snapshot(pool, input.orderId); verifySnapshot(final, input, "succeeded"); verifyUnchanged(baseline, final);
        assert.equal(hash(final), recovered.data.completedHash); assert.equal(final.refunds![0]!.id, recovered.data.refundId);
        result.status = "passed"; result.stage = "complete";
        Object.assign(result.evidence, { crashPid: crashed.pid, crashExit: crashed.exit, recoveryPid: recovered.pid, afterExitHash: hash(afterExit), ...recovered.data });
      } catch (error) { result.status = "failed"; report.errors.push({ window: input.window, stage: result.stage, ...errorInfo(error) }); }
    }
  } catch (error) { report.errors.push({ stage: "preflight", ...errorInfo(error) }); }
  finally {
    let childrenStopped = true;
    try { await children.stopAll(); } catch (error) { childrenStopped = false; report.errors.push({ stage: "child_shutdown", ...errorInfo(error) }); }
    if (fixture && !childrenStopped) report.cleanup.status = "skipped_unconfirmed_children";
    if (fixture && childrenStopped) {
      try {
        await fixture.cleanup();
        for (const orderId of fixture.orders) {
          const remaining = await snapshot(pool!, orderId);
          report.cleanup.remaining[orderId] = Object.fromEntries(Object.entries(remaining).map(([name, values]) => [name, values.length]));
          assert.ok(Object.values(remaining).every(values => values.length === 0), "Every owned fixture row must be removed");
        }
        report.cleanup.status = "passed";
      } catch (error) { report.cleanup.status = "failed"; report.errors.push({ stage: "cleanup", ...errorInfo(error) }); }
    }
    if (pool) try { await bounded(pool.end(), 5000, "Reader pool did not close"); } catch (error) { report.errors.push({ stage: "pool_close", ...errorInfo(error) }); }
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  }
  if (interrupted) report.errors.push({ stage: "interrupted", message: "Parent received SIGINT/SIGTERM; owned children stopped and fixture cleanup attempted" });
  const passed = report.windows.filter(result => result.status === "passed").length;
  console.log(JSON.stringify({ ...report, passed, failed: report.windows.filter(result => result.status === "failed").length,
    notRun: report.windows.filter(result => result.status === "not_run").length, success: passed === report.planned && !report.errors.length && report.cleanup.status === "passed" }, null, 2));
  assert.ok(passed === report.planned && !report.errors.length && report.cleanup.status === "passed", "Crash-window DB check incomplete/failed; retain the full report");
}

export async function checkRefundCrashWindows() {
  for (const window of windows) {
    const sequence: string[] = [];
    const wrapped = commitBarrier(async () => { sequence.push("commit"); }, window, async () => { sequence.push("barrier"); throw new HarnessError("test barrier"); });
    await assert.rejects(wrapped(), /test barrier/);
    assert.deepEqual(sequence, window === "before-commit" ? ["barrier"] : ["commit", "barrier"]);
  }
  const children = new Children(), input: Input = { nonce: randomUUID(), window: "before-commit", orderId: "COUPON-2101" };
  for (const window of windows) {
    const killed = await children.run("pure-pause", { ...input, window }, { barrier: async packet => { assert.equal(packet.data.pure, true); } });
    assert.equal(killed.exit.signal, "SIGKILL");
  }
  await assert.rejects(children.run("pure-wrong-nonce", input, { barrier: async () => { assert.fail("Wrong marker must not be accepted"); } }));
  await assert.rejects(children.run("pure-wrong-pid", input, { barrier: async () => { assert.fail("Foreign PID must not be accepted"); } }));
  await assert.rejects(children.run("pure-exit", input), /exited before/);
  await assert.rejects(children.run("pure-hang", input, { milliseconds: 800 }), /deadline/);
  await children.run("pure-result", input);
  // The outer child is still paused when the inner child is killed; run checks it is alive afterwards.
  await children.run("pure-pause", input, { barrier: async () => { await children.run("pure-pause", input, { barrier: async () => {} }); } });
  const stopping = new Children();
  await assert.rejects(stopping.run("pure-pause", input, { barrier: async () => { await stopping.stopAll(); } }), /still be paused/);
  await assert.rejects(stopping.run("pure-result", input), /coordinator is stopped/);
  assert.throws(() => validateInput({ ...input, nonce: "invalid" }));
  assert.throws(() => validateInput({ ...input, orderId: "COUPON-2001" }));
  assert.throws(() => validateInput({ ...input, pid: process.pid } as Input));
  const operationId = randomUUID(), taskId = randomUUID(), refundId = randomUUID(), withOperation = { ...input, operationId };
  const before: Snapshot = { orders: [{ id: input.orderId, customer_id: "fixture-customer", status: "paid", paid_cents: 7980, total_cents: 7980, refunded_cents: 0 }],
    items: [{ id: "item", order_id: input.orderId }], coupons: [{ order_item_id: "item", status: "unused" }],
    payments: [{ order_id: input.orderId, status: "succeeded", amount_cents: 7980 }],
    tasks: [{ task_id: taskId, order_id: input.orderId, customer_id: "fixture-customer", source_key: source(input), status: "approved", amount_cents: 7980, approved_amount_cents: 7980 }],
    operations: [{ operation_id: operationId, order_id: input.orderId, task_id: taskId, customer_id: "fixture-customer", app_id: identity.appId,
      sender_id: identity.senderId, source_key: source(input), status: "awaiting_confirmation", amount_cents: 7980, presented_at: "2026-01-01T00:00:00.000Z", confirmed_at: null, refund_id: null }],
    refunds: [], scenarios: [{ order_id: input.orderId }], notifications: [] };
  verifySnapshot(before, withOperation, "awaiting_confirmation");
  const after = structuredClone(before);
  Object.assign(after.orders![0]!, { status: "refunded", refunded_cents: 7980 }); after.coupons![0]!.status = "refunded";
  Object.assign(after.operations![0]!, { status: "succeeded", confirmed_at: "2026-01-01T00:00:01.000Z", refund_id: refundId });
  after.refunds!.push({ id: refundId, order_id: input.orderId, status: "succeeded", amount_cents: 7980, completed_at: "2026-01-01T00:00:01.000Z" });
  verifySnapshot(after, withOperation, "succeeded"); verifyUnchanged(before, after);
  for (const change of [(value: Snapshot) => { value.coupons![0]!.status = "unused"; },
    (value: Snapshot) => { value.refunds!.push({ ...value.refunds![0]! }); },
    (value: Snapshot) => { value.refunds![0]!.amount_cents = 7979; },
    (value: Snapshot) => { value.operations![0]!.source_key = "wrong-source"; }]) {
    const corrupt = structuredClone(after); change(corrupt); assert.throws(() => verifySnapshot(corrupt, withOperation, "succeeded"));
  }
  const unrelatedChange = structuredClone(after); unrelatedChange.payments![0]!.status = "failed";
  assert.throws(() => verifyUnchanged(before, unrelatedChange));
  console.log("Refund crash-window pure checks passed: commit ordering, owned child kill/exit, foreign marker rejection, early exit, timeout/shutdown cleanup, survivor isolation and snapshot invariants. No DB/model/QQ calls. DB windows remain NOT RUN.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length === 1 && args[0] === "--check") await checkRefundCrashWindows();
  else if (args.length === 1 && args[0] === "--db") await checkRefundCrashWindowsDatabase();
  else if (args.length === 1 && /^--child=(prepare|crash|recover|pure-pause|pure-wrong-nonce|pure-wrong-pid|pure-exit|pure-hang|pure-result)$/.test(args[0]!)) {
    assert.ok(process.send, "Child modes require IPC; use --check or --db");
    const input = JSON.parse(readFileSync(0, "utf8")) as Input; validateInput(input);
    const mode = args[0]!.slice(8), keepAlive = setInterval(() => {}, 1000);
    try {
      if (mode === "pure-exit") process.exitCode = 9;
      else if (mode === "pure-result") send(input, "result", { pure: true });
      else if (mode === "pure-hang") await new Promise(() => {});
      else if (mode === "pure-wrong-pid") { process.send!({ kind: "barrier", pid: process.ppid, nonce: input.nonce, window: input.window, data: {} }); await new Promise(() => {}); }
      else if (mode === "pure-wrong-nonce") await pauseAtBarrier({ ...input, nonce: randomUUID() }, {});
      else if (mode === "pure-pause") await pauseAtBarrier(input, { pure: true });
      else await databaseChild(mode, input);
    } catch (error) { send(input, "failure", errorInfo(error)); process.exitCode = 1; }
    finally { clearInterval(keepAlive); process.disconnect!(); }
  } else throw new HarnessError("Use --check or --db. DB execution must be explicit and local.");
}
