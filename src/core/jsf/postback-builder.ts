import type { JsfFormSnapshot } from "./form-parser.js";

export type JsfControlPair = readonly [name: string, value: string];

export interface JsfPostbackOptions {
  set?: readonly JsfControlPair[];
  append?: readonly JsfControlPair[];
}

export interface JsfPostback {
  url: string;
  method: "GET" | "POST";
  contentType: "application/x-www-form-urlencoded";
  body: string;
  controls: readonly JsfControlPair[];
}

export class JsfPostbackBuildError extends Error {
  readonly code = "UNKNOWN_CONTROL";

  constructor(name: string) {
    super(`No se puede reemplazar un control que no existe en el formulario: ${name}`);
    this.name = "JsfPostbackBuildError";
  }
}

function applyReplacements(
  controls: readonly JsfControlPair[],
  replacements: readonly JsfControlPair[],
): JsfControlPair[] {
  const replacementsByName = new Map<string, string[]>();
  for (const [name, value] of replacements) {
    const values = replacementsByName.get(name);
    if (values === undefined) replacementsByName.set(name, [value]);
    else values.push(value);
  }

  const knownNames = new Set(controls.map(([name]) => name));
  for (const name of replacementsByName.keys()) {
    if (!knownNames.has(name)) throw new JsfPostbackBuildError(name);
  }

  const emitted = new Set<string>();
  const result: JsfControlPair[] = [];
  for (const control of controls) {
    const [name] = control;
    const values = replacementsByName.get(name);
    if (values === undefined) {
      result.push(control);
    } else if (!emitted.has(name)) {
      result.push(...values.map((value) => [name, value] as const));
      emitted.add(name);
    }
  }
  return result;
}

export function buildJsfPostback(
  snapshot: JsfFormSnapshot,
  { set = [], append = [] }: JsfPostbackOptions = {},
): JsfPostback {
  const controls = [...applyReplacements(snapshot.successfulControls, set), ...append];
  const parameters = new URLSearchParams();
  for (const [name, value] of controls) parameters.append(name, value);
  return {
    url: snapshot.action,
    method: snapshot.method,
    contentType: "application/x-www-form-urlencoded",
    body: parameters.toString(),
    controls,
  };
}
