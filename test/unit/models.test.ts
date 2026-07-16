import { describe, expect, it } from "vitest";

import { checkpointSchema } from "../../src/models/checkpoint.js";
import { scrapedDocumentSchema } from "../../src/models/document.js";
import { httpRequestSpecSchema, orderedPairsSchema } from "../../src/models/http-request.js";
import { parsedPageSchema } from "../../src/models/page.js";

const id = "00000000-0000-4000-8000-000000000001";
const pdfUrl = `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=${id}`;

describe("modelos persistentes", () => {
  it("valida un documento PJ completo y conserva metadata desconocida", () => {
    const document = scrapedDocumentSchema.parse({
      schemaVersion: 1,
      documentId: id,
      partitionId: "supreme",
      sourcePage: 2,
      sourceRow: 10,
      discoveredAt: "2026-07-16T00:00:00.000Z",
      title: "Resolución sintética",
      metadata: {
        list: { Expediente: ["EXP-SYN"] },
        detail: { Sumilla: ["Contenido sintético"] },
        unknownFields: { "Campo nuevo": ["valor"] },
      },
      pdf: { state: "pending", request: { method: "GET", url: pdfUrl } },
    });
    expect(document.documentId).toBe(id);
    expect(document.metadata.unknownFields["Campo nuevo"]).toEqual(["valor"]);
  });

  it("rechaza descriptores PDF con rutas, parámetros u orígenes adicionales", () => {
    for (const url of [
      `https://example.com/jurisprudenciaweb/ServletDescarga?uuid=${id}`,
      `https://jurisprudencia.pj.gob.pe/otra?uuid=${id}`,
      `${pdfUrl}&token=secreto`,
      `${pdfUrl}&uuid=${id}`,
    ]) {
      expect(httpRequestSpecSchema.safeParse({ method: "GET", url }).success).toBe(false);
    }
  });

  it("preserva pares ordenados y nombres repetidos", () => {
    const pairs = orderedPairsSchema.parse([
      ["campo", "uno"],
      ["campo", "dos"],
      ["form:valor", "á"],
    ]);
    expect(pairs).toEqual([
      ["campo", "uno"],
      ["campo", "dos"],
      ["form:valor", "á"],
    ]);
  });

  it("separa total publicado, total de consulta y páginas", () => {
    const page = parsedPageSchema.parse({
      currentPage: 1,
      maxPages: 2,
      pageSize: 10,
      queryTotal: 15,
      publishedGlobalTotal: 20,
      documents: [],
      fingerprint: "a".repeat(64),
      endSignal: "more",
    });
    expect(page).toMatchObject({ queryTotal: 15, publishedGlobalTotal: 20, maxPages: 2 });
  });

  it("rechaza versiones incompatibles de checkpoint", () => {
    expect(
      checkpointSchema.safeParse({
        schemaVersion: 2,
        source: "pj",
        baseUrl: "https://jurisprudencia.pj.gob.pe",
        queryHash: "a".repeat(64),
        partitionId: "supreme",
        page: 1,
        confirmedRow: 0,
        updatedAt: "2026-07-16T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
