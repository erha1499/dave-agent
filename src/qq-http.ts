import { createServer, type Server } from "node:http";
import type { WebhookRequestHandler, WebhookServerAdapter } from "@tencent-connect/qqbot-nodejs";

// The SDK handles signatures and ACK; this adapter bounds the public HTTP input.
export class QQWebhookServer implements WebhookServerAdapter {
  server?: Server;

  async listen(port: number, path: string, handler: WebhookRequestHandler) {
    const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (req, res) => {
      if (req.method !== "POST" || req.url !== path) {
        res.writeHead(404).end();
        req.resume();
        return;
      }
      // ponytail: 64 KiB covers text-only events; revisit before adding rich message payloads.
      const limit = 64 * 1024;
      const rejectLarge = () => {
        res.writeHead(413, { Connection: "close" }).end();
        req.resume();
      };
      if (Number(req.headers["content-length"]) > limit) {
        rejectLarge();
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          length += chunk.length;
          if (length > limit) {
            rejectLarge();
            return;
          }
          chunks.push(chunk);
        }
        const response = await handler({ body: Buffer.concat(chunks), headers: req.headers });
        res.writeHead(response.status, { "Content-Type": "application/json", ...response.headers }).end(response.body);
      } catch {
        if (!res.headersSent) res.writeHead(500).end();
      }
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, resolve);
    });
  }

  close() {
    this.server?.close();
    this.server?.closeAllConnections();
    this.server = undefined;
  }
}
