import { load } from "cheerio";

import { clean } from "./parser-normalization.js";
import { PjStructuralError, type PjPartialResponse } from "./parser-types.js";

export const PARTIAL_RESPONSE_PATTERN =
  /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<partial-response[\s>]/iu;

export function parsePartialResponse(xml: string): PjPartialResponse {
  const $ = load(xml, { xmlMode: true });
  const root = $("partial-response");
  if (root.length !== 1) throw new PjStructuralError("XML PJ no es un partial-response válido");
  const redirect = root.children("redirect").first();
  if (redirect.length > 0) {
    const url = redirect.attr("url");
    if (url === undefined || url === "") throw new PjStructuralError("Redirect parcial PJ sin URL");
    return { kind: "redirect", url };
  }
  const error = root.children("error").first();
  if (error.length > 0) {
    return {
      kind: "error",
      name: clean(error.find("error-name").text()) || "unknown",
      message: clean(error.find("error-message").text()),
    };
  }
  const updates = new Map<string, string>();
  root.find("changes > update").each((_index, update) => {
    const id = $(update).attr("id");
    if (id !== undefined) updates.set(id, $(update).text());
  });
  if (updates.size === 0) throw new PjStructuralError("Respuesta parcial PJ sin updates");
  return { kind: "updates", updates };
}
