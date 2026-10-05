import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool } from "mysql2/promise";
import { EvalStore, readEvalDatabaseConfig } from "./eval-store.ts";
import { analyzeBatch, analyzeEvaluation, compareEvaluations } from "./eval-analysis.ts";
import { experimentCatalog, ExperimentInputError } from "./experiment-config.ts";
import { ExperimentJobs, ExperimentBusyError } from "./experiment-jobs.ts";

const pages = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/experiments.js", ["experiments.js", "text/javascript; charset=utf-8"]],
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

async function readExperimentRequest(req: import("node:http").IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" || req.headers["x-experiment-request"] !== "1")
    throw new ExperimentInputError("实验请求需要 JSON 和 X-Experiment-Request 标识。");
  const body = await new Promise<string>((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024) {
        req.removeListener("data", data); req.resume();
        reject(new ExperimentInputError("实验配置不能超过 32 KiB。"));
      } else chunks.push(chunk);
    };
    req.on("data", data);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
  });
  try { return JSON.parse(body); } catch { throw new ExperimentInputError("实验配置不是有效 JSON。"); }
}

export function createEvaluationServer(store: Pick<EvalStore, "listRuns" | "getRun" | "getBatch" | "ping">,
  experiments?: Pick<ExperimentJobs, "list" | "get" | "start">) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    // Loopback binding plus Host/Origin checks prevent unrelated websites and DNS rebinding from reading history.
    if (!allowedHosts.includes(req.headers.host ?? "") || (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`))
      || req.headers["sec-fetch-site"] === "cross-site") {
      req.resume();
      json(403, { error: "仅允许本机评测工作台访问。" });
      return;
    }
    let url: URL;
    try { url = new URL(req.url ?? "/", `http://${allowedHosts[0]}`); }
    catch { req.resume(); json(400, { error: "请求地址无效。" }); return; }
    if (req.method === "POST" && url.pathname === "/api/experiments" && !url.search && experiments) {
      try { json(202, await experiments.start(await readExperimentRequest(req))); }
      catch (error) {
        req.resume();
        json(error instanceof ExperimentBusyError ? 409 : error instanceof ExperimentInputError ? 400 : 503,
          { error: error instanceof ExperimentBusyError || error instanceof ExperimentInputError ? error.message : "实验暂时无法启动，请检查本机服务。" });
      }
      return;
    }
    req.resume();
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      json(405, { error: "评测工作台只支持读取。" });
      return;
    }
    try {
      if (url.pathname.startsWith("/api/experiments")) {
        if (url.search) { json(400, { error: "实验接口不接受查询参数。" }); return; }
        if (!experiments) { json(503, { error: "实验执行入口未启用。" }); return; }
        if (url.pathname === "/api/experiments/catalog") { json(200, experimentCatalog()); return; }
        if (url.pathname === "/api/experiments") { json(200, { jobs: await experiments.list() }); return; }
        const id = url.pathname.slice("/api/experiments/".length);
        if (!uuid.test(id)) { json(400, { error: "实验 ID 无效。" }); return; }
        const job = await experiments.get(id);
        json(job ? 200 : 404, job ?? { error: "没有找到该实验。" }); return;
      }
      const page = pages.get(url.pathname);
      if (page && url.search === "") {
        const body = await readFile(new URL(`../web/evaluation/${page[0]}`, import.meta.url));
        res.writeHead(200, { "Content-Type": page[1]! }).end(body);
        return;
      }
      if (url.pathname === "/api/health" && !url.search) {
        await store.ping();
        json(200, { ready: true });
        return;
      }
      if (url.pathname === "/api/runs") {
        const limit = url.searchParams.get("limit") ?? "50";
        const kind = url.searchParams.get("kind") ?? "model";
        if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 || !["model", "engineering"].includes(kind)
          || [...url.searchParams.keys()].some(key => !["limit", "kind"].includes(key))
          || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("kind").length > 1) {
          json(400, { error: "运行列表参数无效。" });
          return;
        }
        json(200, { runs: await store.listRuns(Number(limit), kind as "model" | "engineering") });
        return;
      }
      if (url.pathname === "/api/compare") {
        const baseline = url.searchParams.get("baseline"), candidate = url.searchParams.get("candidate");
        if (!baseline || !candidate || !uuid.test(baseline) || !uuid.test(candidate) || baseline === candidate
          || [...url.searchParams.keys()].some(key => !["baseline", "candidate"].includes(key))
          || url.searchParams.getAll("baseline").length !== 1 || url.searchParams.getAll("candidate").length !== 1) {
          json(400, { error: "对比运行参数无效。" }); return;
        }
        const [a, b] = await Promise.all([store.getRun(baseline), store.getRun(candidate)]);
        json(a && b ? 200 : 404, a && b ? compareEvaluations(a, b) : { error: "没有找到对比运行。" }); return;
      }
      if (url.pathname.startsWith("/api/batches/")) {
        const id = url.pathname.slice("/api/batches/".length);
        if (!uuid.test(id) || url.search) { json(400, { error: "批次 ID 无效。" }); return; }
        const runs = await store.getBatch(id);
        json(runs.length ? 200 : 404, runs.length ? analyzeBatch(id, runs) : { error: "没有找到该评测批次。" }); return;
      }
      if (url.pathname.startsWith("/api/runs/")) {
        const analysis = url.pathname.endsWith("/analysis");
        const id = url.pathname.slice("/api/runs/".length, analysis ? -"/analysis".length : undefined);
        if (!uuid.test(id) || url.search) {
          json(400, { error: "运行 ID 无效。" });
          return;
        }
        const detail = await store.getRun(id);
        json(detail ? 200 : 404, detail ? analysis ? analyzeEvaluation(detail) : detail : { error: "没有找到该评测运行。" });
        return;
      }
      json(404, { error: "页面不存在。" });
    } catch {
      json(503, { error: "评测数据暂不可用，请检查本机数据库与评测初始化。" });
    }
  });
}

async function main() {
  const portText = process.env.EVAL_PORT ?? "3001";
  if (!/^\d{4,5}$/.test(portText) || Number(portText) < 1024 || Number(portText) > 65535) throw new Error("EVAL_PORT 无效。");
  const store = new EvalStore(createPool(readEvalDatabaseConfig()));
  const experiments = new ExperimentJobs();
  try {
    await store.ping();
    const server = createEvaluationServer(store, experiments);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(portText), "127.0.0.1", resolve);
    });
    console.log(`评测工作台：http://127.0.0.1:${portText}（历史只读，可显式启动本机实验）`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      server.close();
      server.closeAllConnections();
      await experiments.close();
      await store.close();
    };
    process.once("SIGINT", () => { void close(); });
    process.once("SIGTERM", () => { void close(); });
  } catch {
    await store.close();
    throw new Error("评测工作台启动失败。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(() => {
    console.error("评测工作台启动失败；先运行 npm run eval:init，并检查数据库和 EVAL_PORT 配置。");
    process.exitCode = 1;
  });
}
