import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import axios from "axios";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import { PjHttpClient } from "../../src/core/http-client.js";
import { createLogger } from "../../src/core/logger.js";

describe("transporte HTTP", () => {
  it("PjHttpClient reutiliza una conexión local en solicitudes secuenciales", async () => {
    let connections = 0;
    const receivedCookies: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      receivedCookies.push(request.headers.cookie);
      response.setHeader("Set-Cookie", "SESSION=keep-alive; Path=/");
      response.end("ok");
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const localOrigin = `http://127.0.0.1:${String(port)}`;
    const allowedOrigin = "https://local.pj.test";
    const transport = axios.create({ proxy: false });
    transport.interceptors.request.use((request) => ({
      ...request,
      url: request.url?.replace(allowedOrigin, localOrigin),
    }));
    const baseConfig = loadConfig({
      OUTPUT_DIR: mkdtempSync(path.join(tmpdir(), "pj-keepalive-")),
    });
    const client = new PjHttpClient(
      {
        ...baseConfig,
        baseUrl: allowedOrigin,
        minRequestDelayMs: 0,
        maxRequestDelayMs: 0,
      },
      {
        axiosInstance: transport,
        logger: createLogger({ runId: "keepalive", level: "silent" }),
      },
    );

    try {
      for (let index = 0; index < 5; index += 1) {
        const response = await client.request({
          url: `/jurisprudenciaweb/request-${String(index)}`,
          phase: "discover",
        });
        expect(response.data).toBe("ok");
      }
      expect(connections).toBe(1);
      expect(receivedCookies).toEqual([
        undefined,
        "SESSION=keep-alive",
        "SESSION=keep-alive",
        "SESSION=keep-alive",
        "SESSION=keep-alive",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    }
  });
});
