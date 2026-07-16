import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeCorpus, writeReceiptAtomic } from "../scripts/lib/corpus-finalizer.mjs";

const uuid = (suffix) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const jsonl = (values) => `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const membership = (partitionId, pass, token, identity) => ({
  schemaVersion: 1,
  type: "membership",
  partitionId,
  pass,
  membershipToken: token,
  identity,
  observedAt: "2026-07-16T10:00:00.000Z",
});

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "corpus-finalizer-"));
  await mkdir(path.join(root, "data"));
  const shared = uuid(1);
  const onlyA = uuid(2);
  const onlyB = uuid(3);
  const memberships = [];
  for (const pass of [1, 2]) {
    memberships.push(
      membership("A", pass, shared, { documentUuid: shared, pdfUuid: uuid(101) }),
      membership("A", pass, onlyA, { documentUuid: onlyA, pdfUuid: uuid(102) }),
      membership("B", pass, uuid(11), { pdfUuid: uuid(101) }),
      membership("B", pass, onlyB, { documentUuid: onlyB, pdfUuid: uuid(103) }),
    );
  }
  const documents = [shared, onlyA, onlyB].map((documentId, index) => ({
    schemaVersion: 1,
    documentId,
    partitionId: index === 2 ? "B" : "A",
  }));
  const manifest = documents.flatMap(({ documentId }, index) => [
    { schemaVersion: 1, eventId: uuid(200 + index), documentId, state: "pending" },
    ...(index === 0
      ? [{ schemaVersion: 1, eventId: uuid(210), documentId, state: "downloaded" }]
      : []),
  ]);
  const planPartitions = ["A", "B"].map((id) => ({
    id,
    kind: "main",
    search: { court: id, query: "" },
  }));
  const corpusPlanVersion = "test.r1";
  const corpusPlan = {
    schemaVersion: 1,
    corpusPlanVersion,
    queryHash: sha256({ version: corpusPlanVersion, partitions: planPartitions }),
    commit: "a".repeat(40),
    fingerprint: sha256({
      schemaVersion: 1,
      version: corpusPlanVersion,
      partitions: planPartitions,
    }),
    partitions: planPartitions.map((partition) => ({
      ...partition,
      fingerprint: sha256(partition),
    })),
  };
  const metadata = {
    schemaVersion: 2,
    commit: corpusPlan.commit,
    corpusPlanVersion: corpusPlan.corpusPlanVersion,
    queryHash: corpusPlan.queryHash,
    corpusPlanFingerprint: corpusPlan.fingerprint,
    partitions: corpusPlan.partitions.map(({ id }) => id),
    queryTotals: { A: { initial: 2, final: 2 }, B: { initial: 2, final: 2 } },
    publishedGlobalTotal: { initial: 3, final: 3 },
    notEnumerableWithReason: {
      count: 0,
      reason: "La unión pública cubre el contador publicado.",
      evidenceStatus: "demonstrated",
    },
    scopeApproval: { status: "approved", approver: "owner", evidence: "authorization" },
    ...overrides.metadata,
  };
  await Promise.all([
    writeFile(
      path.join(root, "data", "corpus-memberships.jsonl"),
      jsonl(overrides.memberships ?? memberships),
    ),
    writeFile(path.join(root, "data", "documents.jsonl"), jsonl(overrides.documents ?? documents)),
    writeFile(
      path.join(root, "data", "download-manifest.jsonl"),
      jsonl(overrides.manifest ?? manifest),
    ),
    writeFile(path.join(root, "run-receipt.json"), JSON.stringify(metadata)),
    writeFile(path.join(root, "corpus-plan.json"), JSON.stringify(corpusPlan)),
    writeFile(
      path.join(root, "supervisor.log"),
      overrides.supervisor ??
        "2026-07-16T10:00:00Z pass=1 complete=true new_memberships=4 partitions=2\n2026-07-16T11:00:00Z pass=2 complete=true new_memberships=0 partitions=2\n2026-07-16T11:00:01Z converged=true pass=2\n",
    ),
    writeFile(path.join(root, "discover.log"), overrides.discovery ?? ""),
  ]);
  return { root, memberships, documents, manifest };
}

test("finaliza F0.1 con unión, regiones e intersecciones sin filtrar aliases", async () => {
  const { root } = await fixture();
  const receipt = await finalizeCorpus({ outputDir: root, now: "2026-07-16T12:00:00.000Z" });
  assert.equal(receipt.status, "PASS");
  assert.deepEqual(receipt.reconciliation, {
    rawMemberships: 4,
    uniqueDocuments: 3,
    duplicateOccurrences: 1,
    regionUnion: 3,
    publishedGlobalTotal: { initial: 3, final: 3 },
    notEnumerableWithReason: {
      count: 0,
      reason: "La unión pública cubre el contador publicado.",
      evidenceStatus: "demonstrated",
    },
    equations: {
      rawEqualsUniquePlusDuplicates: true,
      regionsEqualUniqueDocuments: true,
      globalEqualsEnumerablePlusClassifiedDifference: true,
    },
  });
  assert.deepEqual(receipt.membershipRegions, [
    { partitions: ["A"], documents: 1 },
    { partitions: ["A", "B"], documents: 1 },
    { partitions: ["B"], documents: 1 },
  ]);
  assert.deepEqual(receipt.intersections, [{ left: "A", right: "B", documents: 1 }]);
  assert.deepEqual(receipt.inputs.manifestCurrentStates, {
    pending: 2,
    downloaded: 1,
    failed: 0,
    no_pdf: 0,
  });
  const serialized = JSON.stringify(receipt);
  for (let id = 1; id <= 210; id += 1) assert.equal(serialized.includes(uuid(id)), false);
  assert.equal(serialized.includes("documentId"), false);
  assert.equal(serialized.includes("http"), false);
});

test("FAIL honesto si falta clasificación demostrada de la diferencia global", async () => {
  const { root } = await fixture({
    metadata: {
      publishedGlobalTotal: { initial: 4, final: 4 },
      notEnumerableWithReason: { count: null, reason: null, evidenceStatus: "not-demonstrated" },
    },
  });
  const receipt = await finalizeCorpus({ outputDir: root });
  assert.equal(receipt.status, "FAIL");
  assert.equal(
    receipt.reconciliation.equations.globalEqualsEnumerablePlusClassifiedDifference,
    false,
  );
  assert.match(receipt.failureReasons.join(" "), /diferencia no enumerable/i);
});

test("prefiere contadores inicial/final con drift e infiere diferencia cero", async () => {
  const discovery = JSON.stringify({
    command: "discover",
    partitions: [
      { partitionId: "A", queryTotal: 999, initialQueryTotal: 1, finalQueryTotal: 2 },
      { partitionId: "B", queryTotal: 999, initialQueryTotal: 2, finalQueryTotal: 2 },
    ],
    globalTotal: { initial: 3, final: 3 },
  });
  const { root } = await fixture({
    metadata: {
      authorizedAt: "2026-07-16",
      queryTotals: undefined,
      publishedGlobalTotal: undefined,
      notEnumerableWithReason: undefined,
      scopeApproval: undefined,
    },
    discovery,
  });
  const receipt = await finalizeCorpus({ outputDir: root });
  assert.equal(receipt.status, "PASS");
  assert.deepEqual(receipt.partitions.find(({ id }) => id === "A").queryTotals, {
    initial: 1,
    final: 2,
  });
  assert.deepEqual(receipt.reconciliation.notEnumerableWithReason, {
    count: 0,
    reason: "La unión enumerable coincide exactamente con el contador global final.",
    evidenceStatus: "demonstrated",
  });
  assert.equal(receipt.scopeApproval.evidence, "run-receipt.authorizedAt");
});

test("rechaza cobertura distinta entre documents, manifest y aliases fuertes", async () => {
  const base = await fixture();
  await writeFile(
    path.join(base.root, "data", "download-manifest.jsonl"),
    jsonl(base.manifest.slice(0, -1)),
  );
  await assert.rejects(() => finalizeCorpus({ outputDir: base.root }), /documento sin estado/);
});

test("rechaza convergencia declarada que no coincide con primeras apariciones", async () => {
  const { root } = await fixture({
    supervisor:
      "2026-07-16T11:00:00Z pass=2 complete=true new_memberships=1 partitions=2\n2026-07-16T11:00:01Z converged=true pass=2\n",
  });
  await assert.rejects(() => finalizeCorpus({ outputDir: root }), /new_memberships del supervisor/);
});

test("rechaza un recibo cuyo hash u orden no coincide con corpus-plan", async () => {
  const hashMismatch = await fixture({ metadata: { queryHash: "b".repeat(64) } });
  await assert.rejects(
    () => finalizeCorpus({ outputDir: hashMismatch.root }),
    /queryHash no coincide/,
  );

  const orderMismatch = await fixture({ metadata: { partitions: ["B", "A"] } });
  await assert.rejects(
    () => finalizeCorpus({ outputDir: orderMismatch.root }),
    /orden exacto de corpus-plan/,
  );
});

test("rechaza cualquier pendiente detail vigente aunque el supervisor declare convergencia", async () => {
  const { root } = await fixture();
  const failureId = uuid(901);
  const documentId = uuid(1);
  await writeFile(
    path.join(root, "data", "failures.jsonl"),
    jsonl([
      {
        schemaVersion: 1,
        failureId,
        phase: "detail",
        partitionId: "A",
        documentId,
        page: 1,
        classification: "network",
        attempts: 3,
        retryable: true,
        message: "detalle incompleto",
        resolution: "open",
        occurredAt: "2026-07-16T10:00:00.000Z",
      },
    ]),
  );

  const receipt = await finalizeCorpus({ outputDir: root });
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.inputs.openDetailFailures, 1);
  assert.match(receipt.failureReasons.join(" "), /fallos detail abiertos/i);
  assert.equal(JSON.stringify(receipt).includes(failureId), false);
  assert.equal(JSON.stringify(receipt).includes(documentId), false);
});

test("rechaza eventos de failure que no cumplen el schema operativo", async () => {
  const { root } = await fixture();
  await writeFile(
    path.join(root, "data", "failures.jsonl"),
    jsonl([
      {
        schemaVersion: 1,
        failureId: uuid(902),
        phase: "detalle-mal-escrito",
        classification: "network",
        attempts: 1,
        retryable: true,
        message: "evento inválido",
        resolution: "open",
        occurredAt: "2026-07-16T10:00:00.000Z",
      },
    ]),
  );

  await assert.rejects(() => finalizeCorpus({ outputDir: root }), /fase de failure inválida/);
});

test("escribe el recibo atómicamente con permisos privados", async () => {
  const { root } = await fixture();
  const receipt = await finalizeCorpus({ outputDir: root });
  const target = path.join(root, "receipt.json");
  await writeReceiptAtomic(target, receipt);
  assert.equal(JSON.parse(await readFile(target, "utf8")).status, "PASS");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});
