import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool } from "mysql2/promise";
import { EvalStore, readEvalDatabaseConfig } from "./eval-store.ts";

const pages = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createEvaluationServer(store: Pick<EvalStore, "listRuns" | "getRun" | "ping">) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    req.resume();
    // Loopback binding plus Host/Origin checks prevent unrelated websites and DNS rebinding from reading history.
    if (!allowedHosts.includes(req.headers.host ?? "") || (req.headers.origin && !allowedHosts.some(host => req.headers.origin === `http://${host}`))
      || req.headers["sec-fetch-site"] === "cross-site") {
      json(403, { error: "仅允许本机评测工作台访问。" });
      return;
    }
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      json(405, { error: "评测工作台只支持读取。" });
      return;
    }
    try {
      const url = new URL(req.url ?? "/", `http://${allowedHosts[0]}`);
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
      if (url.pathname.startsWith("/api/runs/")) {
        const id = url.pathname.slice("/api/runs/".length);
        if (!uuid.test(id) || url.search) {
          json(400, { error: "运行 ID 无效。" });
          return;
        }
        const detail = await store.getRun(id);
        json(detail ? 200 : 404, detail ?? { error: "没有找到该评测运行。" });
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
  try {
    await store.ping();
    const server = createEvaluationServer(store);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(portText), "127.0.0.1", resolve);
    });
    console.log(`评测工作台：http://127.0.0.1:${portText}（只读）`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      server.close();
      server.closeAllConnections();
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
