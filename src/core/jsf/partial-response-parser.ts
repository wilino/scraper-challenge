import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";
import { SyntaxValidator } from "fast-xml-validator";

export interface JsfPartialResponse {
  updates: Map<string, string>;
  redirectUrl?: string;
  error?: { name?: string; message?: string };
}

interface XmlTextNode {
  "#cdata"?: unknown;
  "#text"?: unknown;
}

interface XmlUpdate extends XmlTextNode {
  id?: unknown;
}

interface XmlError {
  "error-name"?: unknown;
  "error-message"?: unknown;
}

interface PartialRoot {
  changes?: { update?: unknown };
  redirect?: { url?: unknown };
  error?: XmlError;
}

export class JsfPartialResponseParseError extends Error {
  readonly code: "INVALID_XML" | "INVALID_PARTIAL_RESPONSE";
  readonly bodySnapshot: string;

  constructor(code: JsfPartialResponseParseError["code"], message: string, body: string) {
    super(message);
    this.name = "JsfPartialResponseParseError";
    this.code = code;
    this.bodySnapshot = `[REDACTED_XML length=${String(body.length)} sha256=${createHash("sha256").update(body).digest("hex")}]`;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nodeText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const object = record(value) as XmlTextNode | undefined;
  if (object === undefined) return undefined;
  if (typeof object["#cdata"] === "string") return object["#cdata"];
  return typeof object["#text"] === "string" ? object["#text"] : undefined;
}

function safeErrorText(value: unknown): string | undefined {
  const text = nodeText(value)?.trim();
  if (text === undefined || text === "") return undefined;
  return text
    .replace(/(javax\.faces\.ViewState\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/\b(?:token|cookie|authorization)\s*[=:]\s*\S+/gi, "[REDACTED]")
    .slice(0, 500);
}

function isValidXml(xml: string): boolean {
  try {
    return SyntaxValidator.validate(xml) === true;
  } catch {
    return false;
  }
}

export function parseJsfPartialResponse(xml: string): JsfPartialResponse {
  if (!isValidXml(xml) || /<!DOCTYPE/i.test(xml)) {
    throw new JsfPartialResponseParseError(
      "INVALID_XML",
      "La respuesta parcial JSF contiene XML inválido",
      xml,
    );
  }
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    cdataPropName: "#cdata",
    textNodeName: "#text",
    trimValues: false,
    parseTagValue: false,
    isArray: (_name, path) => path === "partial-response.changes.update",
  });
  let parsed: unknown;
  try {
    parsed = parser.parse(xml) as unknown;
  } catch {
    throw new JsfPartialResponseParseError(
      "INVALID_XML",
      "La respuesta parcial JSF contiene XML inválido",
      xml,
    );
  }
  const document = record(parsed);
  const root = record(document?.["partial-response"]) as PartialRoot | undefined;
  if (root === undefined) {
    throw new JsfPartialResponseParseError(
      "INVALID_PARTIAL_RESPONSE",
      "El XML no contiene la raíz partial-response",
      xml,
    );
  }

  const updates = new Map<string, string>();
  const rawUpdates = root.changes?.update;
  const updateList = Array.isArray(rawUpdates)
    ? rawUpdates
    : rawUpdates === undefined
      ? []
      : [rawUpdates];
  for (const value of updateList) {
    const update = record(value) as XmlUpdate | undefined;
    const id = update?.id;
    const content = nodeText(update);
    if (typeof id !== "string" || content === undefined) {
      throw new JsfPartialResponseParseError(
        "INVALID_PARTIAL_RESPONSE",
        "Un nodo update no contiene id y contenido válidos",
        xml,
      );
    }
    if (updates.has(id)) {
      throw new JsfPartialResponseParseError(
        "INVALID_PARTIAL_RESPONSE",
        `La respuesta parcial contiene el update duplicado ${id}`,
        xml,
      );
    }
    updates.set(id, content);
  }

  const redirectUrl = root.redirect?.url;
  const errorName = safeErrorText(root.error?.["error-name"]);
  const errorMessage = safeErrorText(root.error?.["error-message"]);
  return {
    updates,
    ...(typeof redirectUrl === "string" ? { redirectUrl } : {}),
    ...(root.error === undefined
      ? {}
      : {
          error: {
            ...(errorName === undefined ? {} : { name: errorName }),
            ...(errorMessage === undefined ? {} : { message: errorMessage }),
          },
        }),
  };
}
