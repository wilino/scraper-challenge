import { load } from "cheerio";

import {
  JSF_VIEW_STATE_NAME,
  JsfFormParseError,
  parseJsfForm,
  type JsfFormSnapshot,
} from "./form-parser.js";
import { parseJsfPartialResponse, type JsfPartialResponse } from "./partial-response-parser.js";
import { isObservedViewExpiration, JsfRecoverableStateError } from "./view-expiration.js";

export interface PageResponse {
  effectiveUrl: string;
  contentType: string;
  body: string;
  status: number;
}

export interface JsfTransitionOptions {
  requiredUpdateId?: string;
}

export type JsfTransition =
  | { kind: "html"; snapshot: JsfFormSnapshot; html: string }
  | { kind: "partial"; snapshot: JsfFormSnapshot; partial: JsfPartialResponse };

export class JsfResponseError extends Error {
  readonly code: "HTTP_ERROR" | "UNEXPECTED_PAGE" | "PARTIAL_ERROR";
  readonly status?: number;

  constructor(
    code: JsfResponseError["code"],
    message: string,
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JsfResponseError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
  }
}

function isPartialResponse(response: PageResponse): boolean {
  const mediaType = response.contentType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "text/xml" ||
    mediaType === "application/xml" ||
    /^\s*(?:<\?xml[^>]*>\s*)?<partial-response[\s>]/i.test(response.body)
  );
}

function validateSnapshot(snapshot: JsfFormSnapshot): void {
  if (
    snapshot.viewStateName !== JSF_VIEW_STATE_NAME ||
    snapshot.viewStateValue === undefined ||
    snapshot.viewStateValue === ""
  ) {
    throw new JsfResponseError(
      "UNEXPECTED_PAGE",
      "La página recibida no contiene el ViewState JSF observado",
    );
  }
}

function applyPartialUpdates(html: string, partial: JsfPartialResponse): string {
  const $ = load(html);
  for (const [id, content] of partial.updates) {
    let target = $("[id]")
      .filter((_, element) => $(element).attr("id") === id)
      .first();
    if (target.length === 0) {
      target = $("[name]")
        .filter((_, element) => $(element).attr("name") === id)
        .first();
    }
    if (id === JSF_VIEW_STATE_NAME) {
      const viewState = $("input[name]")
        .filter((_, element) => $(element).attr("name") === JSF_VIEW_STATE_NAME)
        .first();
      if (viewState.length > 0) viewState.attr("value", content.trim());
    } else if (target.length > 0) {
      target.replaceWith(content);
    }
  }
  return $.html();
}

export class JsfStateManager {
  readonly #formSelector: string;
  #html?: string;
  #snapshot?: JsfFormSnapshot;

  constructor(formSelector: string) {
    if (formSelector.trim() === "")
      throw new TypeError("El selector del formulario JSF es obligatorio");
    this.#formSelector = formSelector;
  }

  get current(): JsfFormSnapshot {
    if (this.#snapshot === undefined) throw new Error("El estado JSF aún no fue inicializado");
    return this.#snapshot;
  }

  accept(response: PageResponse, options: JsfTransitionOptions = {}): JsfTransition {
    if (isObservedViewExpiration(response)) {
      throw new JsfRecoverableStateError(
        "VIEW_EXPIRED",
        "PJ respondió 500 text/xml vacío: el ViewState ya no es válido",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new JsfResponseError(
        "HTTP_ERROR",
        `Respuesta HTTP JSF no exitosa: ${String(response.status)}`,
        {
          status: response.status,
        },
      );
    }

    if (isPartialResponse(response)) return this.#acceptPartial(response, options);
    return this.#acceptHtml(response);
  }

  #acceptHtml(response: PageResponse): JsfTransition {
    let snapshot: JsfFormSnapshot;
    try {
      snapshot = parseJsfForm(response.body, response.effectiveUrl, this.#formSelector);
      validateSnapshot(snapshot);
    } catch (error) {
      if (error instanceof JsfResponseError) throw error;
      if (error instanceof JsfFormParseError) {
        throw new JsfResponseError(
          "UNEXPECTED_PAGE",
          "La respuesta HTML no coincide con el formulario JSF esperado",
          { cause: error },
        );
      }
      throw error;
    }

    this.#html = response.body;
    this.#snapshot = snapshot;
    return { kind: "html", snapshot, html: response.body };
  }

  #acceptPartial(response: PageResponse, options: JsfTransitionOptions): JsfTransition {
    if (this.#html === undefined || this.#snapshot === undefined) {
      throw new JsfResponseError(
        "UNEXPECTED_PAGE",
        "No se puede aplicar una respuesta parcial antes del bootstrap HTML",
      );
    }

    const partial = parseJsfPartialResponse(response.body);
    if (partial.error !== undefined) {
      if (partial.error.name?.includes("ViewExpiredException") === true) {
        throw new JsfRecoverableStateError("VIEW_EXPIRED", "JSF informó ViewExpiredException");
      }
      throw new JsfResponseError(
        "PARTIAL_ERROR",
        partial.error.name === undefined
          ? "La respuesta parcial JSF contiene un error"
          : `La respuesta parcial JSF contiene el error ${partial.error.name}`,
      );
    }

    if (options.requiredUpdateId !== undefined && !partial.updates.has(options.requiredUpdateId)) {
      throw new JsfRecoverableStateError(
        "STATE_MISMATCH",
        `La respuesta parcial no contiene el update requerido: ${options.requiredUpdateId}`,
      );
    }

    if (partial.redirectUrl !== undefined) {
      return { kind: "partial", snapshot: this.#snapshot, partial };
    }
    const viewState = partial.updates.get(JSF_VIEW_STATE_NAME)?.trim();
    if (viewState === undefined || viewState === "") {
      throw new JsfRecoverableStateError(
        "STATE_MISMATCH",
        "La respuesta parcial válida no contiene un ViewState actualizado",
      );
    }

    const stagedHtml = applyPartialUpdates(this.#html, partial);
    const stagedSnapshot = parseJsfForm(stagedHtml, response.effectiveUrl, this.#formSelector);
    validateSnapshot(stagedSnapshot);
    this.#html = stagedHtml;
    this.#snapshot = stagedSnapshot;
    return { kind: "partial", snapshot: stagedSnapshot, partial };
  }
}
