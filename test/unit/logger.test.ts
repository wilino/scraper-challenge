import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/core/logger.js";

describe("logger seguro", () => {
  it("redacta campos sensibles anidados y secretos embebidos", () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createLogger({ runId: "run-test", level: "info", destination });
    logger.info({
      cookie: "JSESSIONID=real",
      headers: { "Set-Cookie": "secret", Authorization: "Bearer abc.def" },
      credentials: { password: "clave" },
      token: "token-real",
      "javax.faces.ViewState": "VIEWSTATE_COMPLETO",
      url: "https://host/path?access_token=visible",
    });

    const record = JSON.parse(output) as Record<string, unknown>;
    expect(record.time).toEqual(expect.any(Number));
    const stableRecord = { ...record };
    delete stableRecord.time;
    expect(stableRecord).toMatchInlineSnapshot(`
      {
        "cookie": "[REDACTED]",
        "credentials": "[REDACTED]",
        "headers": {
          "Authorization": "[REDACTED]",
          "Set-Cookie": "[REDACTED]",
        },
        "javax.faces.ViewState": "[REDACTED]",
        "level": 30,
        "runId": "run-test",
        "token": "[REDACTED]",
        "url": "https://host/path?access_token=[REDACTED]",
      }
    `);
    expect(output).not.toContain("JSESSIONID=real");
    expect(output).not.toContain("VIEWSTATE_COMPLETO");
    expect(output).not.toContain("Bearer abc.def");
  });
});
