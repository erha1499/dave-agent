import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";

// Only record writes and dispatch events; layout and native controls are checked in the browser.
class Element {
  children: Element[] = [];
  textContent = "";
  value = "";
  disabled = false;
  events = new Map<string, () => unknown>();
  classList = { toggle() {} };
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { if (key === "value") this.value = value; }
  addEventListener(event: string, handler: () => unknown) { this.events.set(event, handler); }
  fire(event: string) { assert.ok(this.events.has(event)); return this.events.get(event)!(); }
}
const content = (element: Element): string => element.textContent + element.children.map(content).join("");
type Response = { ok: boolean; json: () => Promise<unknown> };
type Pending = { path: string; resolve: (response: Response) => void; reject: (error: Error) => void };
const respond = (request: Pending, body: unknown) => request.resolve({ ok: true, json: async () => body });
const result = (id: string) => ({ run: {
  id, label: id, suiteId: "test", suiteName: "test", kind: "model", status: "completed",
  plannedCases: 0, plannedTurns: 0, startedAt: "2026-01-01T00:00:00Z", finishedAt: null, metrics: null,
  snapshot: { gitCommit: "test", gitDirty: false, model: { provider: "test", id: "test" }, hashes: {}, content: {} },
}, cases: [] });
const source = await readFile(new URL("../web/evaluation/app.js", import.meta.url), "utf8");

for (const action of ["reset", "selection", "refresh"]) for (const outcome of ["success", "failure"]) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const pending: Pending[] = [];
  const take = () => { const request = pending.shift(); assert.ok(request); return request; };
  const context = createContext({ Node: Element, document: {
    getElementById: element, createElement: () => new Element(),
    createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }),
  }, fetch: (path: string) => new Promise<Response>((resolve, reject) => pending.push({ path, resolve, reject })) });
  runInContext(source, context, { filename: "web/evaluation/app.js" });
  respond(take(), { runs: [] });
  await setImmediate();
  runInContext('state.runs = [{ id: "a" }, { id: "b" }]', context);
  element("baseline").value = "a";
  element("candidate").value = "b";
  const old = element("compare-button").fire("click");
  const oldRequests = [take(), take()];
  assert.equal(element("compare-button").disabled, true);

  if (action === "refresh") {
    const refresh = element("refresh").fire("click");
    respond(take(), { runs: [] });
    await refresh;
  } else if (action === "selection") {
    element("candidate").value = "c";
    element("candidate").fire("change");
  } else runInContext("resetComparison()", context);
  assert.match(content(element("compare-detail")), /选择两次运行/);

  // A superseding comparison stays busy even when the old request finishes.
  let current: unknown;
  let currentRequests: Pending[] = [];
  if (action !== "refresh") {
    element("baseline").value = "c";
    element("candidate").value = "d";
    current = element("compare-button").fire("click");
    currentRequests = [take(), take()];
  }
  const visible = element("compare-detail").children;
  const disabled = element("compare-button").disabled;
  for (const [index, request] of oldRequests.entries()) {
    if (outcome === "failure" && index === 0) request.reject(new Error("stale request failed"));
    else respond(request, result(request.path));
  }
  await old;
  assert.equal(element("compare-detail").children, visible, `${action}/${outcome}: stale response replaced the current view`);
  assert.equal(element("compare-button").disabled, disabled, `${action}/${outcome}: stale response changed the current button`);

  if (currentRequests.length) {
    for (const request of currentRequests) respond(request, result(request.path));
    await current;
    assert.match(content(element("compare-detail")), /场景对比/);
    assert.equal(element("compare-button").disabled, false);
  }
  assert.equal(pending.length, 0);
}
console.log("PASS 评测前端：重置、切换 A/B、刷新后，旧成功/失败响应不覆盖当前结果或按钮状态。");
