import { load, type CheerioAPI } from "cheerio";

export const JSF_VIEW_STATE_NAME = "javax.faces.ViewState";

export interface JsfFormSnapshot {
  action: string;
  method: "GET" | "POST";
  formId?: string;
  successfulControls: readonly (readonly [name: string, value: string])[];
  viewStateName?: string;
  viewStateValue?: string;
}

export class JsfFormParseError extends Error {
  readonly code: "FORM_NOT_FOUND" | "AMBIGUOUS_FORM" | "INVALID_ACTION" | "MULTIPLE_VIEW_STATES";

  constructor(code: JsfFormParseError["code"], message: string) {
    super(message);
    this.name = "JsfFormParseError";
    this.code = code;
  }
}

function isDisabled($: CheerioAPI, element: Parameters<CheerioAPI>[0]): boolean {
  const control = $(element);
  if (control.is(":disabled") || control.closest("fieldset:disabled").length > 0) return true;
  if (!control.is("option")) return false;
  return control.parent("optgroup:disabled").length > 0;
}

function selectedOptionValues(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
): readonly string[] {
  const select = $(element);
  let selected = select.find("option:selected");
  if (selected.length === 0 && !select.is("[multiple]")) selected = select.find("option").first();

  const values: string[] = [];
  selected.each((_, option) => {
    if (!isDisabled($, option)) values.push($(option).attr("value") ?? $(option).text());
  });
  return values;
}

function successfulControls(
  $: CheerioAPI,
  form: ReturnType<CheerioAPI>,
): readonly (readonly [name: string, value: string])[] {
  const controls: (readonly [string, string])[] = [];

  form.find("input, select, textarea, button").each((_, element) => {
    const control = $(element);
    const name = control.attr("name");
    if (name === undefined || name === "" || isDisabled($, element)) return;

    const tagName = element.tagName.toLowerCase();
    if (tagName === "select") {
      for (const value of selectedOptionValues($, element)) controls.push([name, value]);
      return;
    }
    if (tagName === "textarea") {
      controls.push([name, control.text()]);
      return;
    }
    if (tagName === "button") return;

    const type = (control.attr("type") ?? "text").toLowerCase();
    if (["button", "file", "image", "reset", "submit"].includes(type)) return;
    if (["checkbox", "radio"].includes(type) && !control.is(":checked")) return;
    controls.push([
      name,
      control.attr("value") ?? (type === "checkbox" || type === "radio" ? "on" : ""),
    ]);
  });

  return controls;
}

function immutableSnapshot(snapshot: JsfFormSnapshot): JsfFormSnapshot {
  const controls = snapshot.successfulControls.map(([name, value]) =>
    Object.freeze([name, value] as const),
  );
  return Object.freeze({ ...snapshot, successfulControls: Object.freeze(controls) });
}

export function parseJsfForm(
  html: string,
  effectiveUrl: string,
  formSelector?: string,
): JsfFormSnapshot {
  const $ = load(html);
  const forms = formSelector === undefined ? $("form") : $(formSelector).filter("form");
  if (forms.length === 0) {
    throw new JsfFormParseError("FORM_NOT_FOUND", "No se encontró el formulario JSF objetivo");
  }
  if (forms.length !== 1) {
    throw new JsfFormParseError(
      "AMBIGUOUS_FORM",
      `El selector del formulario JSF no es inequívoco (coincidencias: ${String(forms.length)})`,
    );
  }

  const form = forms.first();
  let action: string;
  try {
    action = new URL(form.attr("action") ?? effectiveUrl, effectiveUrl).href;
  } catch {
    throw new JsfFormParseError(
      "INVALID_ACTION",
      "El action del formulario JSF no es una URL válida",
    );
  }

  const controls = successfulControls($, form);
  const viewStates = controls.filter(([name]) => name === JSF_VIEW_STATE_NAME);
  if (viewStates.length > 1) {
    throw new JsfFormParseError(
      "MULTIPLE_VIEW_STATES",
      "El formulario contiene múltiples controles javax.faces.ViewState",
    );
  }

  const formId = form.attr("id");
  const viewState = viewStates[0];
  return immutableSnapshot({
    action,
    method: (form.attr("method") ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
    ...(formId === undefined || formId === "" ? {} : { formId }),
    successfulControls: controls,
    ...(viewState === undefined
      ? {}
      : { viewStateName: JSF_VIEW_STATE_NAME, viewStateValue: viewState[1] }),
  });
}
