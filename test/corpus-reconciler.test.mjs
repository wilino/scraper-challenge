import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileNdjson } from "../scripts/lib/corpus-reconciler.mjs";

const fixture = readFileSync(
  new URL("./fixtures/pj/corpus-reconciliation-input.ndjson", import.meta.url),
  "utf8",
);
const ndjson = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
const uuid = (suffix) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
const baseRun = (published = 2) => ({
  type: "run",
  schemaVersion: 1,
  origin: "synthetic-contractual",
  observed: false,
  capturedAt: "2026-07-16T04:00:00Z",
  commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  environment: { country: "Synthetic", access: "offline" },
  definitions: {},
  publishedGlobalTotal: { initial: published, final: published },
  notEnumerableWithReason: {
    count: 0,
    reason: "Sintético enumerable.",
    evidenceStatus: "demonstrated",
  },
  scopeApproval: {
    status: "approved",
    approver: "synthetic-owner",
    evidence: "synthetic-approval",
  },
});
const partition = {
  type: "partition",
  id: "P",
  classification: "included",
  evidence: ["synthetic"],
};
const pass = (number, total = 2) => ({
  type: "pass",
  partitionId: "P",
  pass: number,
  initialTotal: total,
  finalTotal: total,
  completed: true,
});
const membership = (passNumber, token, identity) => ({
  type: "membership",
  partitionId: "P",
  pass: passNumber,
  membershipToken: token,
  identity,
});

test("deriva ecuaciones, regiones triples, intersecciones y prioridad sin filtrar identidades", () => {
  const receipt = reconcileNdjson(fixture);
  assert.equal(receipt.status, "PASS");
  assert.deepEqual(receipt.reconciliation, {
    rawMemberships: 9,
    uniqueDocuments: 5,
    duplicateOccurrences: 4,
    enumeratedDocuments: 9,
    withResolvedIdentity: 9,
    unresolvedIdentity: 0,
    publishedGlobalTotal: { initial: 5, final: 5, stable: true },
    publiclyEnumerableCorpus: 5,
    notEnumerableWithReason: {
      count: 0,
      reason: "El universo sintético completo es enumerable.",
      evidenceStatus: "demonstrated",
    },
    unknownTerms: [],
  });
  assert.deepEqual(receipt.membershipRegions, [
    { partitions: ["P1"], documents: 1 },
    { partitions: ["P1", "P2"], documents: 2 },
    { partitions: ["P1", "P2", "P3"], documents: 1 },
    { partitions: ["P3"], documents: 1 },
  ]);
  assert.equal(
    receipt.intersections.find(({ left, right }) => left === "P1" && right === "P2").documents,
    3,
  );
  assert.deepEqual(receipt.partitions.find(({ id }) => id === "P1").identityResolutionCounts, {
    documentUuid: 1,
    pdfUuid: 1,
    nonCollidingComposite: 1,
    reviewedHash: 1,
    unresolved: 0,
  });
  const output = JSON.stringify(receipt);
  assert.equal(/00000000-0000-4000-8000-/.test(output), false);
  assert.equal(output.includes("TOKEN-P1-A"), false);
  assert.equal(output.includes("EXP-SYN-C"), false);
  assert.equal(
    output.includes("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    false,
  );
});

test("una clave compuesta repetida sin identidad superior queda sin resolver", () => {
  const composite = {
    composite: {
      expediente: "EXP-COLLISION",
      fecha: "2000-01-01",
      sala: "SALA-X",
      tipo: "TIPO-X",
      normalizationVersion: "v1",
    },
  };
  const events = [baseRun(), partition, pass(1), pass(2)];
  for (const number of [1, 2])
    events.push(
      membership(number, "TOKEN-C1", composite),
      membership(number, "TOKEN-C2", composite),
    );
  const receipt = reconcileNdjson(ndjson(events));
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.reconciliation.unresolvedIdentity, 2);
  assert.equal(receipt.reconciliation.uniqueDocuments, null);
  assert.deepEqual(receipt.membershipRegions, []);
});

test("rechaza cuando el mismo PDF enlaza UUIDs de documento distintos", () => {
  const sharedPdf = uuid("990001");
  const events = [
    baseRun(),
    partition,
    pass(1),
    membership(1, "TOKEN-A1", { documentUuid: uuid("1"), pdfUuid: sharedPdf }),
    membership(1, "TOKEN-A2", { documentUuid: uuid("2"), pdfUuid: sharedPdf }),
  ];
  assert.throws(
    () => reconcileNdjson(ndjson(events)),
    /alias PDF enlaza UUIDs de documento distintos/,
  );
});

test("rechaza una revisión hash que no cubre exactamente el grupo", () => {
  const value = "c".repeat(64);
  const identity = { contentHash: { algorithm: "sha256", value, normalizationVersion: "v1" } };
  const events = [
    baseRun(),
    partition,
    pass(1),
    membership(1, "TOKEN-H1", identity),
    membership(1, "TOKEN-H2", identity),
    {
      type: "hashReview",
      value,
      normalizationVersion: "v1",
      equivalenceClasses: [[{ partitionId: "P", membershipToken: "TOKEN-H1" }]],
      reviewer: "reviewer",
      evidenceRef: "evidence",
    },
  ];
  assert.throws(() => reconcileNdjson(ndjson(events)), /no cubre exactamente/);
});

test("una enumeración sin pasada final de cero identidades no puede pasar", () => {
  const events = [
    baseRun(1),
    { ...partition },
    { ...pass(1, 1) },
    membership(1, "TOKEN-ONLY", { documentUuid: uuid("7") }),
  ];
  const receipt = reconcileNdjson(ndjson(events));
  assert.equal(receipt.status, "FAIL");
  assert.equal(receipt.consistencyStrategy.liveConvergenceObserved, false);
  assert.match(receipt.failureReasons.join(" "), /pasada completa sin identidades nuevas/);
});

test("una última pasada que no cubre queryTotal impide PASS", () => {
  const events = [
    baseRun(1),
    { ...partition },
    { ...pass(1, 2) },
    { ...pass(2, 2) },
    membership(1, "TOKEN-ONLY", { documentUuid: uuid("8") }),
    membership(2, "TOKEN-ONLY", { documentUuid: uuid("8") }),
  ];
  const receipt = reconcileNdjson(ndjson(events));
  assert.equal(receipt.status, "FAIL");
  assert.match(receipt.failureReasons.join(" "), /no reconcilia con su queryTotal final/);
});

test("el resultado es determinista aunque cambie el orden de eventos membership", () => {
  const events = fixture.trim().split("\n").map(JSON.parse);
  const fixed = events.filter(({ type }) => type !== "membership");
  const memberships = events.filter(({ type }) => type === "membership").reverse();
  assert.deepEqual(reconcileNdjson(ndjson([...fixed, ...memberships])), reconcileNdjson(fixture));
});
