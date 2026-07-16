import axios from "axios";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import nock from "nock";
import pino from "pino";
import { CookieJar } from "tough-cookie";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("toolchain", () => {
  it("expone todas las APIs base requeridas", () => {
    expect(typeof axios.create).toBe("function");
    expect(typeof cheerio.load).toBe("function");
    expect(typeof XMLParser).toBe("function");
    expect(typeof nock).toBe("function");
    expect(typeof pino).toBe("function");
    expect(typeof CookieJar).toBe("function");
    expect(typeof z.object).toBe("function");
  });
});
