export function clean(value: string): string {
  return value
    .replace(/\u00a0/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function addValue(target: Record<string, string[]>, key: string, value: string): void {
  const values = target[key] ?? [];
  values.push(value);
  target[key] = values;
}

const LIST_NORMALIZED_FIELDS = {
  recurso: "title",
  nroexp: "caseNumber",
  tipoResolucion: "resolutionType",
  fechaResolucion: "resolutionDate",
  sumilla: "summary",
} as const;

export function normalizeListMetadata(metadata: Record<string, string[]>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [field, normalizedName] of Object.entries(LIST_NORMALIZED_FIELDS)) {
    const value = metadata[field]?.[0];
    if (value !== undefined && value !== "") normalized[normalizedName] = value;
  }
  return normalized;
}
