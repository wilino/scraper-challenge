import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DiscoveryOrchestrator } from "../../src/core/discovery-orchestrator.js";
import {
  DiscoveryStopError,
  type DiscoveryPage,
  type DiscoverySource,
  type EnrichRecordContext,
} from "../../src/core/discovery-types.js";
import type { ScrapedDocument } from "../../src/models/document.js";
import { scrapeFailureSchema } from "../../src/models/failure.js";
import type { PjListRecord } from "../../src/sites/pj/parser.js";

const uuid = (number: number): string =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function record(number: number, row: number): PjListRecord {
  return {
    nativeId: uuid(number),
    recordIndex: row,
    row,
    metadata: { nroexp: [`EXP-${String(number)}`] },
    normalized: { caseNumber: `EXP-${String(number)}` },
    detail: {
      source: `formBuscador:repeat:${String(row)}:j_idt491`,
      nativeId: uuid(number),
      parameters: [["uuid", uuid(number)]],
    },
  };
}

function page(
  partitionId: string,
  currentPage: number,
  maxPages: number,
  queryTotal: number,
  records: PjListRecord[],
  viewState = `VIEW_${String(currentPage)}`,
): DiscoveryPage {
  return {
    partitionId,
    parsed: {
      viewState,
      queryTotal,
      publishedGlobalTotal: 999,
      records,
      pagination: {
        currentPage,
        maxPages,
        pageSize: 10,
        hasNext: currentPage < maxPages,
        hasLast: currentPage < maxPages,
        endSignal: currentPage === maxPages ? "natural_end" : "more",
      },
      fingerprint: "a".repeat(64),
    },
  };
}

class FakeSource implements DiscoverySource {
  readonly #pages: Readonly<Record<string, DiscoveryPage[]>>;
  readonly #pdfUuid?: string;
  readonly #pdfIdentityTokens: ReadonlySet<string>;
  active = 0;
  maxActive = 0;
  enriched = 0;
  opened: [string, number][] = [];

  public constructor(
    pages: Readonly<Record<string, DiscoveryPage[]>>,
    pdfUuid?: string,
    pdfIdentityTokens: ReadonlySet<string> = new Set(),
  ) {
    this.#pages = pages;
    this.#pdfUuid = pdfUuid;
    this.#pdfIdentityTokens = pdfIdentityTokens;
  }

  public preflight(): Promise<void> {
    return Promise.resolve();
  }

  public openPartition(partitionId: string, resumePage: number): Promise<DiscoveryPage> {
    this.opened.push([partitionId, resumePage]);
    const result = this.#pages[partitionId]?.find(
      ({ parsed }) => parsed.pagination.currentPage === resumePage,
    );
    if (result === undefined) throw new Error("Página fake ausente");
    return Promise.resolve(result);
  }

  public async enrichRecord(
    item: PjListRecord,
    context: EnrichRecordContext,
  ): Promise<ScrapedDocument> {
    this.active += 1;
    this.enriched += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    return {
      schemaVersion: 1,
      documentId: item.nativeId,
      partitionId: context.partitionId,
      sourcePage: context.page,
      sourceRow: context.row,
      discoveredAt: "2026-07-16T00:00:00.000Z",
      caseNumber: item.normalized.caseNumber,
      metadata: { list: item.metadata, detail: { exclusivo: ["detalle"] }, unknownFields: {} },
      pdf:
        this.#pdfUuid === undefined
          ? { state: "no_pdf", reason: "not_advertised" }
          : {
              state: "pending",
              request: {
                method: "GET",
                url: `https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/ServletDescarga?uuid=${this.#pdfUuid}`,
              },
            },
    };
  }

  public nextPage(current: DiscoveryPage): Promise<DiscoveryPage | null> {
    const nextNumber = current.parsed.pagination.currentPage + 1;
    return Promise.resolve(
      this.#pages[current.partitionId]?.find(
        ({ parsed }) => parsed.pagination.currentPage === nextNumber,
      ) ?? null,
    );
  }

  public membershipIdentity(item: PjListRecord): { documentUuid: string } | { pdfUuid: string } {
    return this.#pdfIdentityTokens.has(item.nativeId)
      ? { pdfUuid: item.nativeId }
      : { documentUuid: item.nativeId };
  }
}

async function output(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "pj-discovery-"));
}

function orchestrator(
  source: DiscoverySource,
  outputDirectory: string,
  partitions = ["supreme"],
  passNumber = 1,
) {
  return new DiscoveryOrchestrator({
    source,
    outputDirectory,
    baseUrl: "https://jurisprudencia.pj.gob.pe",
    queryHash: "a".repeat(64),
    partitions,
    corpusReconciliationPassed: true,
    passNumber,
    now: () => new Date("2026-07-16T00:00:00.000Z"),
  });
}

describe("orquestador de descubrimiento", () => {
  it("recorre fixtures multipágina secuencialmente y genera documentos y manifest", async () => {
    const root = await output();
    const source = new FakeSource({
      supreme: [
        page("supreme", 1, 2, 3, [record(1, 0), record(2, 1)]),
        page("supreme", 2, 2, 3, [record(3, 0)]),
      ],
    });
    const summary = await orchestrator(source, root).run();

    expect(summary).toMatchObject({
      termination: "natural_end",
      datasetComplete: true,
      pagesVisited: 2,
      rawMemberships: 3,
      uniqueDocuments: 3,
      duplicates: 0,
    });
    expect(source.maxActive).toBe(1);
    expect(
      (await readFile(path.join(root, "data/documents.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(3);
    expect(
      (await readFile(path.join(root, "data/download-manifest.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(3);
  });

  it("tolera drift de queryTotal y maxPages y conserva sus extremos", async () => {
    const root = await output();
    const source = new FakeSource({
      supreme: [
        page("supreme", 1, 3, 4, [record(1, 0), record(2, 1)]),
        page("supreme", 2, 2, 5, [record(3, 0)]),
      ],
    });

    const summary = await orchestrator(source, root).run();

    expect(summary).toMatchObject({
      termination: "natural_end",
      datasetComplete: true,
      rawMemberships: 3,
    });
    expect(summary.partitions[0]).toMatchObject({
      initialQueryTotal: 4,
      finalQueryTotal: 5,
      queryTotal: 5,
      initialMaxPages: 3,
      finalMaxPages: 2,
      maxPages: 2,
      drift: true,
      rawMemberships: 3,
      uniqueMemberships: 3,
      duplicateMemberships: 0,
    });
  });

  it("mantiene la reconciliación exacta contra queryTotal cuando no existe drift", async () => {
    const root = await output();
    const source = new FakeSource({
      supreme: [
        page("supreme", 1, 2, 4, [record(1, 0), record(2, 1)]),
        page("supreme", 2, 2, 4, [record(3, 0)]),
      ],
    });

    await expect(orchestrator(source, root).run()).rejects.toMatchObject({
      reason: "reconciliation_mismatch",
    });
  });

  it("persiste el alias PDF y lo recupera sin enriquecer otra vez en la siguiente pasada", async () => {
    const root = await output();
    const pages = { supreme: [page("supreme", 1, 1, 1, [record(301, 0)])] };
    const pdfUuid = uuid(9301);
    const firstSource = new FakeSource(pages, pdfUuid);
    await orchestrator(firstSource, root).run();

    const secondSource = new FakeSource(pages);
    await orchestrator(secondSource, root, ["supreme"], 2).run();

    expect(secondSource.enriched).toBe(0);
    const memberships = (await readFile(path.join(root, "data/corpus-memberships.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { pass: number; identity: Record<string, string> });
    expect(memberships).toHaveLength(2);
    expect(memberships[1]).toMatchObject({
      pass: 2,
      identity: { documentUuid: uuid(301), pdfUuid },
    });
  });

  it("reutiliza un documento principal cuando la partición histórica llega por su UUID PDF", async () => {
    const root = await output();
    const documentUuid = uuid(401);
    const pdfUuid = uuid(9401);
    const source = new FakeSource(
      {
        supreme: [page("supreme", 1, 1, 1, [record(401, 0)])],
        historical: [page("historical", 1, 1, 1, [record(9401, 0)])],
      },
      pdfUuid,
      new Set([pdfUuid]),
    );

    const summary = await orchestrator(source, root, ["supreme", "historical"]).run();

    expect(documentUuid).not.toBe(pdfUuid);
    expect(source.enriched).toBe(1);
    expect(summary).toMatchObject({ uniqueDocuments: 1, duplicates: 1 });
    expect(
      (await readFile(path.join(root, "data/documents.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    const memberships = (await readFile(path.join(root, "data/corpus-memberships.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { partitionId: string; identity: Record<string, string> });
    expect(memberships).toEqual([
      expect.objectContaining({
        partitionId: "supreme",
        identity: { documentUuid, pdfUuid },
      }),
      expect.objectContaining({
        partitionId: "historical",
        identity: { pdfUuid },
      }),
    ]);
  });

  it("detecta una página repetida aunque cambie ViewState", async () => {
    const root = await output();
    const source = new FakeSource({
      supreme: [
        page("supreme", 1, 3, 3, [record(1, 0)], "VIEW_A"),
        page("supreme", 2, 3, 3, [record(1, 0)], "VIEW_B"),
      ],
    });
    await expect(orchestrator(source, root).run()).rejects.toMatchObject({
      reason: "repeated_fingerprint",
    });
  });

  it("omite y contabiliza un duplicado entre páginas", async () => {
    const root = await output();
    const source = new FakeSource({
      supreme: [
        page("supreme", 1, 2, 3, [record(1, 0), record(2, 1)]),
        page("supreme", 2, 2, 3, [record(2, 0)]),
      ],
    });
    const summary = await orchestrator(source, root).run();
    expect(summary).toMatchObject({ uniqueDocuments: 2, duplicates: 1 });
    expect(summary.partitions[0]).toMatchObject({
      rawMemberships: 3,
      uniqueMemberships: 2,
      duplicateMemberships: 1,
      globalDuplicates: 1,
    });
    expect(source.enriched).toBe(2);
  });

  it("limita en mitad de página, conserva la fila y reanuda sin duplicar", async () => {
    const root = await output();
    const pages = { supreme: [page("supreme", 1, 1, 2, [record(1, 0), record(2, 1)])] };
    const firstSource = new FakeSource(pages);
    const limited = await orchestrator(firstSource, root).run({ limit: 1 });
    expect(limited).toMatchObject({
      termination: "limit",
      datasetComplete: false,
      uniqueDocuments: 1,
    });
    expect(
      JSON.parse(await readFile(path.join(root, "state/checkpoint.json"), "utf8")),
    ).toMatchObject({
      page: 1,
      confirmedRow: 1,
    });

    const resumedSource = new FakeSource(pages);
    const resumed = await orchestrator(resumedSource, root).run({ resume: true });
    expect(resumedSource.opened).toEqual([["supreme", 1]]);
    expect(resumed).toMatchObject({
      termination: "natural_end",
      datasetComplete: true,
      uniqueDocuments: 1,
    });
    expect(
      (await readFile(path.join(root, "data/documents.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(2);
  });

  it("reconcilia particiones solapadas sin duplicar el JSONL global", async () => {
    const root = await output();
    const source = new FakeSource({
      supreme: [page("supreme", 1, 1, 2, [record(1, 0), record(2, 1)])],
      superior: [page("superior", 1, 1, 2, [record(2, 0), record(3, 1)])],
    });
    const summary = await orchestrator(source, root, ["supreme", "superior"]).run();
    expect(summary).toMatchObject({ rawMemberships: 4, uniqueDocuments: 3, duplicates: 1 });
    expect(summary.partitions[1]).toMatchObject({ queryTotal: 2, globalDuplicates: 1 });
    expect(
      (await readFile(path.join(root, "data/documents.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(3);
  });

  it("reconstruye el índice tras una caída entre documents.jsonl y checkpoint", async () => {
    const root = await output();
    const persisted: ScrapedDocument = {
      schemaVersion: 1,
      documentId: uuid(1),
      partitionId: "supreme",
      sourcePage: 1,
      sourceRow: 0,
      discoveredAt: "2026-07-16T00:00:00.000Z",
      metadata: { list: {}, detail: { exclusivo: ["detalle"] }, unknownFields: {} },
      pdf: { state: "no_pdf", reason: "not_advertised" },
    };
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data/documents.jsonl"),
      `${JSON.stringify(persisted)}\n`,
      "utf8",
    );
    const source = new FakeSource({ supreme: [page("supreme", 1, 1, 1, [record(1, 0)])] });
    const summary = await orchestrator(source, root).run();
    expect(summary).toMatchObject({ uniqueDocuments: 0, duplicates: 1 });
    expect(
      (await readFile(path.join(root, "data/documents.jsonl"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
    expect(await readFile(path.join(root, "state/completed-ids.txt"), "utf8")).toContain(uuid(1));
  });

  it("mantiene G3 bloqueado aunque todas las particiones terminen naturalmente", async () => {
    const root = await output();
    const source = new FakeSource({ supreme: [page("supreme", 1, 1, 1, [record(1, 0)])] });
    const summary = await new DiscoveryOrchestrator({
      source,
      outputDirectory: root,
      baseUrl: "https://jurisprudencia.pj.gob.pe",
      queryHash: "b".repeat(64),
      partitions: ["supreme"],
    }).run();
    expect(summary).toMatchObject({ datasetComplete: false, corpusGate: "blocked" });
    expect(summary.diagnostics[0]).toMatch(/fase 0\.1/u);
  });

  it("clasifica interrupción y no la disfraza como éxito", async () => {
    const root = await output();
    const controller = new AbortController();
    controller.abort();
    const source = new FakeSource({ supreme: [page("supreme", 1, 1, 1, [record(1, 0)])] });
    await expect(
      orchestrator(source, root).run({ signal: controller.signal }),
    ).rejects.toBeInstanceOf(DiscoveryStopError);
    await expect(
      orchestrator(source, root).run({ signal: controller.signal }),
    ).rejects.toMatchObject({
      reason: "interrupted",
    });
  });

  it("persiste un fallo de detalle sin confirmar el documento", async () => {
    const root = await output();
    const source = new FakeSource({ supreme: [page("supreme", 1, 1, 1, [record(1, 0)])] });
    source.enrichRecord = () => Promise.reject(new Error("respuesta sensible no debe persistirse"));
    await expect(orchestrator(source, root).run()).rejects.toThrow("respuesta sensible");
    const failure = scrapeFailureSchema.parse(
      JSON.parse((await readFile(path.join(root, "data/failures.jsonl"), "utf8")).trim()),
    );
    expect(failure).toMatchObject({
      phase: "detail",
      documentId: uuid(1),
      classification: "network",
      resolution: "open",
    });
    expect(failure.message).not.toContain("sensible");
    await expect(readFile(path.join(root, "state/checkpoint.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
