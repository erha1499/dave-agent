import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { CouponStore, readDatabaseConfig } from "./coupon-store.ts";
import { WebChatError, WebChatSessions } from "./web-chat.ts";
import { createWebChatAgentFactory, createWebChatSettingsCatalog } from "./web-chat-settings.ts";

const pages = new Map([
  ["/", ["../web/chat/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["../web/chat/app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["../web/chat/style.css", "text/css; charset=utf-8"]],
  ["/ui.css", ["../web/evaluation/style.css", "text/css; charset=utf-8"]],
]);
const cookieName = "dave_chat";
function capability(req: IncomingMessage) {
  const values = (req.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
async function readBody(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json" || req.headers["x-chat-request"] !== "1")
    throw new WebChatError(400, "请求需要 JSON 和 X-Chat-Request 标识。");
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let length = 0; const chunks: Buffer[] = [];
    const timer = setTimeout(() => { req.resume(); reject(new WebChatError(400, "请求正文读取超时。")); }, 5000);
    const stop = (error: unknown) => { clearTimeout(timer); reject(error); };
    req.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 8192) { req.resume(); stop(new WebChatError(400, "请求正文不能超过 8 KiB。")); }
      else chunks.push(chunk);
    });
    req.once("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
    req.once("error", stop);
    req.once("aborted", () => stop(new WebChatError(400, "请求已中断。")));
  });
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!object(body)) throw new Error();
    return body;
  } catch { throw new WebChatError(400, "请求正文不是有效的 JSON 对象。"); }
}

export function createWebChatServer(chat: WebChatSessions) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
    const json = (status: number, body: unknown) => {
      if (!res.destroyed && !res.writableEnded) res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const allowed = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    if (!allowed.includes(req.headers.host ?? "") || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      || (req.headers["sec-fetch-site"] && !["same-origin", "same-site", "none"].includes(String(req.headers["sec-fetch-site"])))) {
      req.resume(); json(403, { error: "仅允许本机同源客服页面访问。" }); return;
    }
    const singleHeaders = ["host", "origin", "cookie", "content-type", "x-chat-request", "sec-fetch-site"];
    if (singleHeaders.some(name => req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index]!.toLowerCase() === name).length > 1)) {
      req.resume(); json(400, { error: "请求标识不能重复。" }); return;
    }
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new WebChatError(400, "请求地址无效。");
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.search) throw new WebChatError(400, "客服入口不接受查询参数。");
      const token = capability(req);
      if (req.method === "GET" && url.pathname === "/api/chat/config") {
        req.resume(); json(200, await chat.config()); return;
      }
      if (req.method === "GET" && url.pathname === "/api/chat/session") {
        req.resume(); json(200, chat.get(token)); return;
      }
      if (req.method === "POST" && ["/api/chat/session", "/api/chat/messages", "/api/chat/messages/stream"].includes(url.pathname)) {
        const body = await readBody(req);
        if (url.pathname === "/api/chat/session") {
          if (typeof body.profileId !== "string" || !Object.hasOwn(body, "sessionId")
            || Object.keys(body).some(key => !["profileId", "settings", "sessionId"].includes(key)))
            throw new WebChatError(400, "新对话只接受 profileId、sessionId 及完整 settings。");
          const created = await chat.create(token, body.profileId, body.settings, body.sessionId);
          res.setHeader("Set-Cookie", `${cookieName}=${created.token}; HttpOnly; SameSite=Strict; Path=/`);
          json(200, { session: created.session, messages: created.messages }); return;
        }
        if (Object.keys(body).length !== 3 || !["text", "requestId", "sessionId"].every(key => Object.hasOwn(body, key))
          || typeof body.text !== "string" || typeof body.requestId !== "string" || typeof body.sessionId !== "string")
          throw new WebChatError(400, "发送消息只接受 sessionId、requestId 和 text。");
        if (url.pathname === "/api/chat/messages/stream") {
          const stream = (event: string, data: unknown) => {
            if (res.destroyed || res.writableEnded) return;
            if (!res.headersSent) {
              res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
              res.flushHeaders();
            }
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          try {
            const result = await chat.send(token, body.requestId, body.text, body.sessionId, ({ type, ...data }) => stream(type, data));
            stream("result", result);
          } catch (error) {
            if (!res.headersSent) throw error;
            stream("error", { sessionId: body.sessionId, requestId: body.requestId,
              status: error instanceof WebChatError ? error.status : 503,
              error: error instanceof WebChatError ? error.message : "客服服务暂时不可用，请稍后重试。" });
          }
          if (!res.destroyed && !res.writableEnded) res.end();
          return;
        }
        const result = await chat.send(token, body.requestId, body.text, body.sessionId);
        // Only creation sets the cookie: a late message response must not replace or clear a newer conversation.
        json(200, result); return;
      }
      req.resume();
      const page = pages.get(url.pathname);
      if (req.method === "GET" && page) {
        const body = await readFile(new URL(page[0]!, import.meta.url));
        res.writeHead(200, { "Content-Type": page[1]! }).end(body); return;
      }
      json(404, { error: "页面或接口不存在。" });
    } catch (error) {
      req.resume();
      json(error instanceof WebChatError ? error.status : 503,
        { error: error instanceof WebChatError ? error.message : "客服服务暂时不可用，请稍后重试。" });
    }
  });
}

async function main() {
  const port = process.env.CHAT_PORT ?? "3002";
  if (!/^\d{4,5}$/u.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("CHAT_PORT 无效。");
  const config = readDatabaseConfig();
  if (config.user !== "dave_agent_read") throw new Error("网页首版仅支持项目只读数据库账户。");
  const pool = createPool(config), store = new CouponStore(pool);
  let chat: WebChatSessions | undefined;
  try {
    const [rows] = await pool.query<RowDataPacket[]>({ sql: "SHOW GRANTS FOR CURRENT_USER()", timeout: 5000 });
    const grants = rows.map(row => String(Object.values(row)[0]));
    if (!grants.length || !grants.every(line => /^GRANT (?:USAGE ON \*\.\*|SELECT ON `[^`]+`\.\*) TO /u.test(line) && !/WITH GRANT OPTION/u.test(line))
      || !grants.some(line => /^GRANT SELECT /u.test(line))) throw new Error("网页账户必须只有只读权限。");
    await store.ping();
    const env = { ...process.env }, catalog = createWebChatSettingsCatalog(env);
    await catalog;
    chat = new WebChatSessions(store, createWebChatAgentFactory(store, env), 60_000, catalog);
    const server = createWebChatServer(chat);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(port), "127.0.0.1", resolve); });
    console.log(`网页客服：http://127.0.0.1:${port}（合成数据，仅只读咨询）`);
    let closing = false;
    const close = async () => {
      if (closing) return; closing = true;
      chat!.close(); server.close(); server.closeAllConnections(); await store.close();
    };
    process.once("SIGINT", () => { void close().catch(() => { process.exitCode = 1; }); });
    process.once("SIGTERM", () => { void close().catch(() => { process.exitCode = 1; }); });
  } catch {
    chat?.close(); await store.close(); throw new Error("网页客服启动失败。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main().catch(() => {
  console.error("网页客服启动失败，请检查本机只读数据库和 CHAT_PORT 配置。"); process.exitCode = 1;
});
