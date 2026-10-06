import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { AfterSalesStore, merchantSourceKey, readAfterSalesDatabaseConfig, type MerchantTask } from "../src/after-sales.ts";
import type { QQIdentity } from "../src/coupon-store.ts";
import { dispatchMerchantNotifications } from "../src/merchant-notifications.ts";
import type { QQAgent } from "../src/qq-agent.ts";
import { createMerchantFixture } from "./merchant-test-fixture.ts";
import { setupMerchantReferences } from "./merchant-references-setup.ts";

function admin(sql: string) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "mysql", "sh", "-c",
    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B --default-character-set=utf8mb4 dave_agent'], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), input: sql, encoding: "utf8", timeout: 15_000,
  });
  if (result.error || result.status !== 0) throw new Error("任务引用独立 fixture 准备或清理失败。");
  return result.stdout.trim();
}

export async function checkMerchantReferencesDatabase() {
  const nonce = randomBytes(8).toString("hex"), identity: QQIdentity = { appId: `MR_DB_${nonce}`, senderId: `owner_${nonce}` };
  const peer = { ...identity, senderId: `peer_${nonce}` }, otherApp = { ...identity, appId: `MR_ALT_${nonce}` };
  const fixture = await createMerchantFixture(Array.from({ length: 15 }, () => "approve" as const), { delayMs: 5000 });
  const pool = createPool(readAfterSalesDatabaseConfig()), store = new AfterSalesStore(pool);
  const group = (label: string) => `mr-${nonce}-${label}`;
  const key = (label: string, who = identity) => merchantSourceKey(who, group(label));
  const refs = (label: string, who = identity) => store.listTaskReferences(who, key(label, who), group(label));
  const identities = [identity, peer, otherApp];
  const tasks = new Map<string, MerchantTask>();
  const ids = fixture.orders.map(() => "?").join(",");
  const facts = async () => {
    const [orders] = await pool.execute<RowDataPacket[]>(`SELECT id, customer_id, status, paid_cents, refunded_cents FROM orders WHERE id IN (${ids}) ORDER BY id`, fixture.orders);
    const [refunds] = await pool.execute<RowDataPacket[]>(`SELECT order_id, status, amount_cents FROM refunds WHERE order_id IN (${ids}) ORDER BY order_id`, fixture.orders);
    const [requests] = await pool.execute<RowDataPacket[]>(`SELECT task_id, order_id, CAST(identity_id AS CHAR) AS identity_id, source_key, created_at FROM merchant_requests WHERE order_id IN (${ids}) ORDER BY order_id`, fixture.orders);
    return { orders, refunds, requests };
  };
  const notification = async (taskId: string) => (await pool.execute<RowDataPacket[]>(
    "SELECT status, claimed_at, finished_at FROM merchant_notifications WHERE task_id = ?", [taskId]))[0][0];
  async function create(index: number, label: string, outcome?: "terminal" | "sent" | "deferred" | "unknown" | "claimed" | "queued") {
    const orderId = fixture.orders[index]!;
    const task = await store.request(identity, key(label), orderId, "独立任务来源验证", outcome && outcome !== "terminal"
      ? { groupOpenid: group(label), messageId: `mr-message-${nonce}-${index}`, timestamp: new Date().toISOString() } : undefined);
    tasks.set(label, task);
    if (!outcome) await fixture.holdMerchant(orderId);
    else {
      assert.equal(await store.applyResult({ taskId: task.taskId, orderId, status: "approved", approvedAmountCents: 7980 }), true);
      if (outcome !== "terminal" && outcome !== "queued") {
        assert.equal(await store.claimNotification(task.taskId, identity.appId), true);
        if (outcome !== "claimed") await store.finishNotification(task.taskId, identity.appId, outcome);
      }
    }
    return task;
  }
  function expireCreation(task: MerchantTask) {
    assert.ok(fixture.orders.includes(task.orderId));
    admin(`UPDATE merchant_requests SET created_at = UTC_TIMESTAMP(3) - INTERVAL 16 MINUTE WHERE task_id = '${task.taskId}' AND order_id = '${task.orderId}';`);
  }
  function bindIdentities() {
    for (const who of identities) admin(`INSERT INTO qq_identities (app_id, sender_id, customer_id)
      SELECT '${who.appId}', '${who.senderId}', customer_id FROM qq_identities WHERE app_id = 'TEST_APP' AND sender_id = 'TEST_USER1';`);
  }
  try {
    bindIdentities(); await store.ping();
    const [columns] = await pool.execute<RowDataPacket[]>("SELECT IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='merchant_requests' AND COLUMN_NAME='identity_id'");
    assert.equal(columns[0]?.nullable, "YES", "Run merchant-references-setup before this check");
    const initialFacts = await facts();
    for (const [index, label, outcome] of [[0, "pending", undefined], [1, "terminal", "terminal"], [2, "sent", "sent"],
      [3, "deferred", "deferred"], [4, "unknown", "unknown"], [5, "claimed", "claimed"]] as const) {
      const task = await create(index, label, outcome), listed = await refs(label);
      assert.equal(listed.overflow, false); assert.equal(listed.candidates.length, 1);
      const reference = listed.candidates[0]!;
      assert.deepEqual(Object.keys(reference).sort(), ["anchorAt", "expiresAt", "orderId", "origin", "taskId"]);
      assert.equal(reference.taskId, task.taskId); assert.equal(reference.orderId, task.orderId);
      assert.equal(reference.origin, outcome === "sent" ? "sent" : "confirmed");
      const anchor = outcome === "sent" ? (await notification(task.taskId))!.finished_at as Date : new Date(task.createdAt);
      assert.equal(reference.anchorAt, anchor.getTime()); assert.equal(reference.expiresAt, reference.anchorAt + 15 * 60_000);
      assert.deepEqual(await refs(label), listed, "Reading a reference never renews its anchor or expiry");
    }
    const pending = tasks.get("pending")!, beforeReplay = await refs("pending");
    const replayed = await Promise.all(Array.from({ length: 4 }, () => store.request(identity, key("pending"), pending.orderId, "重复确认")));
    assert.ok(replayed.every(task => task.taskId === pending.taskId && task.createdAt === pending.createdAt));
    assert.deepEqual(await refs("pending"), beforeReplay);
    console.log("[merchant-references] pending/terminal confirmation, sent-only event provenance, fixed TTL and idempotent confirmation PASS");

    for (const label of ["pending", "terminal", "deferred", "unknown", "claimed"]) {
      expireCreation(tasks.get(label)!); assert.deepEqual(await refs(label), { candidates: [], overflow: false });
    }
    expireCreation(tasks.get("sent")!);
    assert.equal((await refs("sent")).candidates[0]?.origin, "sent", "A recent actual sent event survives an expired creation anchor");
    const sentTask = tasks.get("sent")!;
    admin(`UPDATE merchant_notifications SET claimed_at = UTC_TIMESTAMP(3) - INTERVAL 16 MINUTE,
      finished_at = UTC_TIMESTAMP(3) - INTERVAL 16 MINUTE WHERE task_id = '${sentTask.taskId}';`);
    assert.deepEqual(await refs("sent"), { candidates: [], overflow: false });
    const laterSent = await create(6, "later-sent", "sent"); expireCreation(laterSent);
    const retainedSent = await refs("later-sent"); assert.equal(retainedSent.candidates[0]?.origin, "sent");
    console.log("[merchant-references] expiry excludes confirmation/unknown/deferred/claimed; recent sent has its own fixed window PASS");

    const legacy = await create(7, "legacy", "queued");
    admin(`UPDATE merchant_requests SET identity_id = NULL WHERE task_id = '${legacy.taskId}' AND order_id = '${legacy.orderId}';`);
    await setupMerchantReferences(); await setupMerchantReferences();
    assert.deepEqual(await refs("legacy"), { candidates: [], overflow: false });
    assert.ok(await store.getTask(identity, key("legacy"), legacy.orderId), "Legacy explicit order queries remain available");
    assert.equal(await store.getTask(identity, key("legacy"), legacy.orderId, { referenceTaskId: legacy.taskId }), undefined);
    assert.ok(!(await store.listNotifications(identity.appId)).some(item => item.taskId === legacy.taskId));
    assert.equal(await store.claimNotification(legacy.taskId, identity.appId), false);
    await store.request(identity, key("legacy"), legacy.orderId, "旧记录重复确认");
    const [legacyRows] = await pool.execute<RowDataPacket[]>("SELECT identity_id FROM merchant_requests WHERE task_id = ?", [legacy.taskId]);
    assert.equal(legacyRows[0]?.identity_id, null, "Migration and replay never backfill legacy ownership provenance");
    console.log("[merchant-references] idempotent migration, legacy NULL exclusion and explicit-query compatibility PASS");

    for (const [who, channel] of [[peer, group("later-sent")], [otherApp, group("later-sent")], [identity, group("other")]] as const) {
      assert.deepEqual(await store.listTaskReferences(who, merchantSourceKey(who, channel), channel), { candidates: [], overflow: false });
    }
    await assert.rejects(store.listTaskReferences(identity, key("later-sent"), group("other")));
    await assert.rejects(store.listTaskReferences(peer, key("later-sent"), group("later-sent")));
    await assert.rejects(store.listTaskReferences(identity, "invalid", group("later-sent")));
    const transfer = await create(9, "transfer", "queued");
    admin(`UPDATE orders SET customer_id = (SELECT customer_id FROM qq_identities WHERE app_id='TEST_APP' AND sender_id='TEST_USER2') WHERE id='${transfer.orderId}';`);
    try {
      assert.deepEqual(await refs("transfer"), { candidates: [], overflow: false });
      assert.equal(await store.getTask(identity, key("transfer"), transfer.orderId, { referenceTaskId: transfer.taskId }), undefined);
      assert.ok(!(await store.listNotifications(identity.appId)).some(item => item.taskId === transfer.taskId));
      assert.equal(await store.claimNotification(transfer.taskId, identity.appId), false);
    } finally {
      admin(`UPDATE orders SET customer_id = (SELECT customer_id FROM qq_identities WHERE app_id='${identity.appId}' AND sender_id='${identity.senderId}') WHERE id='${transfer.orderId}';`);
    }
    const exact = await store.getTask(identity, key("transfer"), transfer.orderId, { referenceTaskId: transfer.taskId }); assert.ok(exact);
    assert.equal(await store.getTask(identity, key("transfer"), transfer.orderId, { referenceTaskId: randomUUID() }), undefined);
    console.log("[merchant-references] app/user/group/source isolation, current ownership and exact notification task PASS");

    for (let index = 10; index < 14; index++) await create(index, "overflow");
    const bounded = await refs("overflow"); assert.equal(bounded.candidates.length, 3); assert.equal(bounded.overflow, true);
    assert.equal(new Set(bounded.candidates.map(item => item.taskId)).size, 3);
    const [ordered] = await pool.execute<RowDataPacket[]>("SELECT task_id FROM merchant_requests WHERE source_key=? ORDER BY created_at DESC, task_id DESC", [key("overflow")]);
    assert.deepEqual(bounded.candidates.map(item => item.taskId), ordered.slice(0, 3).map(row => row.task_id));
    const beforeReads = await facts();
    for (let count = 0; count < 3; count++) assert.deepEqual(await refs("overflow"), bounded);
    assert.deepEqual(await facts(), beforeReads, "Reference reads cannot repeat task creation or business writes");
    console.log("[merchant-references] three candidates plus overflow, stable order and no business writes on lookup PASS");

    const queued = await create(8, "rebind", "queued");
    const oldListing = (await store.listNotifications(identity.appId)).filter(item => item.taskId === queued.taskId);
    assert.equal(oldListing.length, 1);
    const oldBinding = admin(`SELECT id FROM qq_identities WHERE app_id='${identity.appId}' AND sender_id='${identity.senderId}';`);
    admin(`DELETE FROM qq_identities WHERE app_id='${identity.appId}' AND sender_id='${identity.senderId}';`);
    assert.deepEqual(await refs("rebind"), { candidates: [], overflow: false });
    admin(`INSERT INTO qq_identities (app_id,sender_id,customer_id) SELECT '${identity.appId}','${identity.senderId}',customer_id
      FROM qq_identities WHERE app_id='TEST_APP' AND sender_id='TEST_USER1';`);
    assert.notEqual(admin(`SELECT id FROM qq_identities WHERE app_id='${identity.appId}' AND sender_id='${identity.senderId}';`), oldBinding);
    assert.deepEqual(await refs("later-sent"), { candidates: [], overflow: false });
    assert.deepEqual(await refs("rebind"), { candidates: [], overflow: false });
    assert.deepEqual(await store.listNotifications(identity.appId), []);
    assert.equal(await store.claimNotification(queued.taskId, identity.appId), false);
    assert.equal(await store.getTask(identity, key("rebind"), queued.orderId, { referenceTaskId: queued.taskId }), undefined);
    assert.ok(await store.getTask(identity, key("rebind"), queued.orderId), "Explicit current-owner queries are intentionally compatible");
    // A list acquired before rebinding still has to pass claim and resolver checks after dequeue.
    const staleListing = { listNotifications: async () => oldListing, claimNotification: store.claimNotification.bind(store),
      getTask: store.getTask.bind(store), finishNotification: store.finishNotification.bind(store) } as unknown as AfterSalesStore;
    let sends = 0;
    const localTransport = { async resumeMerchant(_message: unknown, resolve: () => Promise<MerchantTask | undefined>) {
      if (!await resolve()) return "deferred"; sends++; return "sent";
    } } as unknown as QQAgent;
    await dispatchMerchantNotifications(staleListing, localTransport, identity.appId, [group("rebind")]);
    assert.equal(sends, 0); assert.equal((await notification(queued.taskId))?.status, "pending");
    const claimedBeforeRebind = tasks.get("claimed")!;
    await store.finishNotification(claimedBeforeRebind.taskId, identity.appId, "sent");
    assert.deepEqual(await refs("claimed"), { candidates: [], overflow: false }, "A late sent receipt cannot authorize the new binding");
    const fresh = await create(14, "new-binding"); assert.equal((await refs("new-binding")).candidates[0]?.taskId, fresh.taskId);
    console.log("[merchant-references] unbind/same-customer rebind, old sent/late sent and stale queued notification rejection PASS");

    const finalFacts = await facts();
    assert.deepEqual(finalFacts.orders, initialFacts.orders); assert.deepEqual(finalFacts.refunds, initialFacts.refunds);
    assert.equal(finalFacts.requests.length, fixture.orders.length);
    assert.equal(new Set(finalFacts.requests.map(row => row.task_id)).size, fixture.orders.length);
    await assert.rejects(pool.execute("DELETE FROM merchant_requests WHERE 1=0"));
    console.log("PASS merchant references: real MySQL with isolated synthetic fixtures and local dispatcher resolver; zero model or QQ requests.");
  } finally {
    try { await fixture.cleanup(); }
    finally {
      try { for (const who of identities) admin(`DELETE FROM qq_identities WHERE app_id='${who.appId}' AND sender_id='${who.senderId}';`); }
      finally { await store.close(); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMerchantReferencesDatabase();
