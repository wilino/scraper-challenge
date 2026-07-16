import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FAILURE_PHASES = new Set(["preflight", "discover", "detail", "download"]);
const FAILURE_RESOLUTIONS = new Set(["open", "resolved", "abandoned"]);
const FAILURE_CLASSIFICATIONS = new Set([
  "access",
  "network",
  "timeout",
  "rate_limit",
  "http_permanent",
  "structural",
  "security",
  "invalid_content",
  "interrupted",
]);

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function validateCorpusPlanArtifact(artifact) {
  invariant(artifact?.schemaVersion === 1, "corpus-plan.schemaVersion inválido");
  invariant(
    typeof artifact.corpusPlanVersion === "string" && artifact.corpusPlanVersion,
    "corpusPlanVersion inválido",
  );
  invariant(SHA256.test(artifact.queryHash ?? ""), "corpus-plan.queryHash inválido");
  invariant(COMMIT.test(artifact.commit ?? ""), "corpus-plan.commit inválido");
  invariant(SHA256.test(artifact.fingerprint ?? ""), "corpus-plan.fingerprint inválido");
  invariant(
    Array.isArray(artifact.partitions) && artifact.partitions.length > 0,
    "corpus-plan sin particiones",
  );
  const partitions = artifact.partitions.map((partition) => {
    invariant(
      typeof partition?.id === "string" && partition.id,
      "corpus-plan partitionId inválido",
    );
    invariant(typeof partition.kind === "string" && partition.kind, "corpus-plan kind inválido");
    invariant(
      partition.search !== null && typeof partition.search === "object",
      "corpus-plan search inválido",
    );
    invariant(SHA256.test(partition.fingerprint ?? ""), "fingerprint de partición inválido");
    const canonical = { id: partition.id, kind: partition.kind, search: partition.search };
    invariant(
      partition.fingerprint === sha256(canonical),
      `fingerprint inválido para ${partition.id}`,
    );
    return canonical;
  });
  invariant(
    new Set(partitions.map(({ id }) => id)).size === partitions.length,
    "corpus-plan contiene particiones duplicadas",
  );
  invariant(
    artifact.queryHash === sha256({ version: artifact.corpusPlanVersion, partitions }),
    "corpus-plan.queryHash no corresponde al contenido",
  );
  invariant(
    artifact.fingerprint ===
      sha256({ schemaVersion: 1, version: artifact.corpusPlanVersion, partitions }),
    "corpus-plan.fingerprint no corresponde al contenido",
  );
  return partitions;
}

function validateFailure(failure) {
  invariant(failure?.schemaVersion === 1 && UUID.test(failure.failureId ?? ""), "failure inválido");
  invariant(FAILURE_PHASES.has(failure.phase), "fase de failure inválida");
  invariant(FAILURE_RESOLUTIONS.has(failure.resolution), "resolución de failure inválida");
  invariant(
    FAILURE_CLASSIFICATIONS.has(failure.classification),
    "clasificación de failure inválida",
  );
  invariant(
    Number.isInteger(failure.attempts) && failure.attempts > 0,
    "attempts de failure inválido",
  );
  invariant(typeof failure.retryable === "boolean", "retryable de failure inválido");
  invariant(typeof failure.message === "string" && failure.message, "message de failure inválido");
  invariant(!Number.isNaN(Date.parse(failure.occurredAt ?? "")), "occurredAt de failure inválido");
  if (failure.partitionId !== undefined)
    invariant(
      typeof failure.partitionId === "string" && failure.partitionId,
      "partitionId de failure inválido",
    );
  if (failure.documentId !== undefined)
    invariant(UUID.test(failure.documentId), "documentId de failure inválido");
  if (failure.page !== undefined)
    invariant(Number.isInteger(failure.page) && failure.page > 0, "page de failure inválido");
  if (failure.status !== undefined)
    invariant(
      Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599,
      "status de failure inválido",
    );
  if (failure.code !== undefined)
    invariant(typeof failure.code === "string" && failure.code, "code de failure inválido");
  if (failure.retryAfterMs !== undefined)
    invariant(
      Number.isInteger(failure.retryAfterMs) && failure.retryAfterMs >= 0,
      "retryAfterMs de failure inválido",
    );
  for (const [field, value] of [
    ["nextRetryAt", failure.nextRetryAt],
    ["resolvedAt", failure.resolvedAt],
  ])
    if (value !== undefined)
      invariant(!Number.isNaN(Date.parse(value)), `${field} de failure inválido`);
  if (failure.request !== undefined) validateFailureRequest(failure.request);
  if (failure.phase === "detail")
    invariant(UUID.test(failure.documentId ?? ""), "detail failure sin documentId");
}

function validateFailureRequest(request) {
  invariant(
    request !== null &&
      typeof request === "object" &&
      Object.keys(request).sort().join(",") === "method,url",
    "request de failure inválido",
  );
  invariant(
    request.method === "GET" && typeof request.url === "string",
    "request de failure inválido",
  );
  let url;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error("request.url de failure inválido");
  }
  const uuids = url.searchParams.getAll("uuid");
  invariant(
    url.origin === "https://jurisprudencia.pj.gob.pe" &&
      url.pathname === "/jurisprudenciaweb/ServletDescarga" &&
      [...url.searchParams.keys()].every((key) => key === "uuid") &&
      uuids.length === 1 &&
      UUID.test(uuids[0] ?? "") &&
      url.username === "" &&
      url.password === "",
    "request.url de failure inseguro",
  );
}

class DisjointSet {
  constructor(size) {
    this.parent = new Int32Array(size);
    for (let index = 0; index < size; index += 1) this.parent[index] = index;
  }

  find(index) {
    invariant(index >= 0 && index < this.parent.length, "identidad interna inexistente");
    const parent = this.parent[index];
    if (parent !== index) this.parent[index] = this.find(parent);
    return this.parent[index];
  }

  union(left, right) {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    if (a < b) this.parent[b] = a;
    else this.parent[a] = b;
  }
}

const logicalKey = ({ partitionId, membershipToken }) =>
  `${partitionId}\u0000${membershipToken.toLowerCase()}`;

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${path.basename(file)} inválido: ${error.message}`, { cause: error });
  }
}

async function readJsonLines(file, visit) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let number = 0;
  try {
    for await (const raw of lines) {
      number += 1;
      if (!raw.trim()) continue;
      let value;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        throw new Error(`${path.basename(file)} línea ${number}: ${error.message}`, {
          cause: error,
        });
      }
      await visit(value, number);
    }
  } catch (error) {
    input.destroy();
    throw error;
  }
}

async function readOptionalJsonLines(file, visit) {
  try {
    await readJsonLines(file, visit);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

function validateMembership(event) {
  invariant(event?.schemaVersion === 1 && event.type === "membership", "membership inválida");
  invariant(typeof event.partitionId === "string" && event.partitionId, "partitionId inválido");
  invariant(Number.isInteger(event.pass) && event.pass > 0, "pass inválido");
  invariant(UUID.test(event.membershipToken), "membershipToken inválido");
  const { documentUuid, pdfUuid } = event.identity ?? {};
  invariant(documentUuid !== undefined || pdfUuid !== undefined, "membership sin alias fuerte");
  if (documentUuid !== undefined) invariant(UUID.test(documentUuid), "documentUuid inválido");
  if (pdfUuid !== undefined) invariant(UUID.test(pdfUuid), "pdfUuid inválido");
}

function parseSupervisorLog(text) {
  const completePasses = new Map();
  let convergedPass = null;
  for (const line of text.split(/\r?\n/u)) {
    const complete =
      /\bpass=(\d+)\s+complete=true\s+new_memberships=(\d+)\s+partitions=(\d+)\b/u.exec(line);
    if (complete)
      completePasses.set(Number(complete[1]), {
        newMemberships: Number(complete[2]),
        partitions: Number(complete[3]),
      });
    const converged = /\bconverged=true\s+pass=(\d+)\b/u.exec(line);
    if (converged) convergedPass = Number(converged[1]);
  }
  return { completePasses, convergedPass };
}

function parseDiscoveryLog(text) {
  const totals = new Map();
  const globals = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim().startsWith("{")) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.command !== "discover" || !Array.isArray(value.partitions)) continue;
    for (const partition of value.partitions) {
      if (
        typeof partition.partitionId !== "string" ||
        ![partition.initialQueryTotal, partition.finalQueryTotal, partition.queryTotal].some(
          Number.isInteger,
        )
      )
        continue;
      const observed = totals.get(partition.partitionId) ?? { initial: [], final: [] };
      const compatibleTotal = Number.isInteger(partition.queryTotal) ? partition.queryTotal : null;
      observed.initial.push(
        Number.isInteger(partition.initialQueryTotal)
          ? partition.initialQueryTotal
          : compatibleTotal,
      );
      observed.final.push(
        Number.isInteger(partition.finalQueryTotal) ? partition.finalQueryTotal : compatibleTotal,
      );
      totals.set(partition.partitionId, observed);
    }
    for (const total of [value.globalTotal?.initial, value.globalTotal?.final])
      if (Number.isInteger(total)) globals.push(total);
  }
  return { totals, globals };
}

const sorted = (values) => [...values].sort();

export async function finalizeCorpus(options) {
  const outputDir = path.resolve(options.outputDir);
  const dataDir = path.join(outputDir, "data");
  const files = {
    memberships: path.join(dataDir, "corpus-memberships.jsonl"),
    documents: path.join(dataDir, "documents.jsonl"),
    manifest: path.join(dataDir, "download-manifest.jsonl"),
    failures: path.join(dataDir, "failures.jsonl"),
    corpusPlan: path.join(outputDir, "corpus-plan.json"),
    metadata: path.resolve(options.metadataPath ?? path.join(outputDir, "run-receipt.json")),
    supervisor: path.resolve(options.supervisorLogPath ?? path.join(outputDir, "supervisor.log")),
    discovery: path.resolve(options.discoveryLogPath ?? path.join(outputDir, "discover.log")),
  };
  const corpusPlan = await readJson(files.corpusPlan);
  const corpusPartitions = validateCorpusPlanArtifact(corpusPlan);
  const metadata = await readJson(files.metadata);
  invariant(metadata.schemaVersion === 2, "run-receipt.schemaVersion inválido");
  invariant(COMMIT.test(metadata.commit ?? ""), "la corrida no está ligada a un commit");
  invariant(
    Array.isArray(metadata.partitions) && metadata.partitions.length > 0,
    "faltan particiones",
  );
  invariant(
    metadata.commit === corpusPlan.commit,
    "run-receipt.commit no coincide con corpus-plan",
  );
  invariant(
    metadata.corpusPlanVersion === corpusPlan.corpusPlanVersion,
    "run-receipt.corpusPlanVersion no coincide con corpus-plan",
  );
  invariant(
    metadata.queryHash === corpusPlan.queryHash,
    "run-receipt.queryHash no coincide con corpus-plan",
  );
  invariant(
    metadata.corpusPlanFingerprint === corpusPlan.fingerprint,
    "run-receipt.corpusPlanFingerprint no coincide con corpus-plan",
  );
  invariant(
    JSON.stringify(metadata.partitions) === JSON.stringify(corpusPartitions.map(({ id }) => id)),
    "run-receipt.partitions no conserva el orden exacto de corpus-plan",
  );
  const expectedPartitions = sorted(new Set(metadata.partitions));
  invariant(
    expectedPartitions.length === metadata.partitions.length &&
      expectedPartitions.every((partition) => typeof partition === "string" && partition),
    "particiones de corrida inválidas o duplicadas",
  );

  const membershipIndex = new Map();
  const memberships = [];
  const passCounts = new Map();
  let lastObservedPass = 0;
  let membershipRecords = 0;
  await readJsonLines(files.memberships, (event) => {
    validateMembership(event);
    invariant(
      expectedPartitions.includes(event.partitionId),
      "membership de partición no declarada",
    );
    invariant(event.pass >= lastObservedPass, "las memberships no están ordenadas por pasada");
    lastObservedPass = event.pass;
    const key = logicalKey(event);
    const existingIndex = membershipIndex.get(key);
    const documentUuid = event.identity.documentUuid?.toLowerCase();
    const pdfUuid = event.identity.pdfUuid?.toLowerCase();
    if (existingIndex === undefined) {
      membershipIndex.set(key, memberships.length);
      memberships.push({
        partitionId: event.partitionId,
        firstPass: event.pass,
        lastPass: event.pass,
        documentUuid,
        pdfUuid,
      });
    } else {
      const member = memberships[existingIndex];
      invariant(member.lastPass !== event.pass, "membership duplicada dentro de una pasada");
      invariant(
        member.documentUuid === undefined ||
          documentUuid === undefined ||
          member.documentUuid === documentUuid,
        "un token cambia de UUID de documento",
      );
      invariant(
        member.pdfUuid === undefined || pdfUuid === undefined || member.pdfUuid === pdfUuid,
        "un token cambia de UUID de PDF",
      );
      member.documentUuid ??= documentUuid;
      member.pdfUuid ??= pdfUuid;
      member.lastPass = event.pass;
    }
    const perPass = passCounts.get(event.pass) ?? new Map();
    perPass.set(event.partitionId, (perPass.get(event.partitionId) ?? 0) + 1);
    passCounts.set(event.pass, perPass);
    membershipRecords += 1;
  });
  invariant(memberships.length > 0, "corpus-memberships.jsonl está vacío");
  membershipIndex.clear();

  const dsu = new DisjointSet(memberships.length);
  const aliasOwner = new Map();
  for (let index = 0; index < memberships.length; index += 1) {
    const member = memberships[index];
    for (const alias of [member.documentUuid, member.pdfUuid]) {
      if (alias === undefined) continue;
      const previous = aliasOwner.get(alias);
      if (previous !== undefined) dsu.union(previous, index);
      else aliasOwner.set(alias, index);
    }
  }
  const documentAliasesByRoot = new Map();
  for (let index = 0; index < memberships.length; index += 1) {
    const member = memberships[index];
    if (member.documentUuid === undefined) continue;
    const root = dsu.find(index);
    const alias = documentAliasesByRoot.get(root);
    invariant(
      alias === undefined || alias === member.documentUuid,
      "un alias de PDF enlaza UUID de documentos distintos",
    );
    documentAliasesByRoot.set(root, member.documentUuid);
  }

  const documents = new Map();
  await readJsonLines(files.documents, (document) => {
    invariant(
      document?.schemaVersion === 1 && UUID.test(document.documentId ?? ""),
      "documento inválido",
    );
    const id = document.documentId.toLowerCase();
    invariant(!documents.has(id), "documentId duplicado en documents.jsonl");
    invariant(
      expectedPartitions.includes(document.partitionId),
      "documento de partición no declarada",
    );
    documents.set(id, null);
  });

  let manifestEvents = 0;
  await readJsonLines(files.manifest, (event) => {
    invariant(event?.schemaVersion === 1 && UUID.test(event.documentId ?? ""), "manifest inválido");
    invariant(
      ["pending", "downloaded", "failed", "no_pdf"].includes(event.state),
      "estado manifest inválido",
    );
    const id = event.documentId.toLowerCase();
    invariant(documents.has(id), "manifest contiene un documentId inexistente");
    documents.set(id, event.state);
    manifestEvents += 1;
  });
  for (const state of documents.values())
    invariant(state !== null, "documento sin estado en manifest");
  for (const id of documents.keys())
    invariant(aliasOwner.has(id), "documento sin membership de identidad fuerte");
  const documentCount = documents.size;
  const manifestCounts = { pending: 0, downloaded: 0, failed: 0, no_pdf: 0 };
  for (const state of documents.values()) manifestCounts[state] += 1;
  documents.clear();

  const currentFailures = new Map();
  await readOptionalJsonLines(files.failures, (failure) => {
    validateFailure(failure);
    currentFailures.set(failure.failureId.toLowerCase(), failure);
  });
  const openDetailFailures = [...currentFailures.values()].filter(
    (failure) => failure.phase === "detail" && failure.resolution === "open",
  ).length;
  currentFailures.clear();

  invariant(expectedPartitions.length <= 30, "demasiadas particiones para el agregador");
  const partitionBits = new Map(
    expectedPartitions.map((partition, index) => [partition, 1 << index]),
  );
  const partitionMaskByRoot = new Map();
  for (let index = 0; index < memberships.length; index += 1) {
    const member = memberships[index];
    const root = dsu.find(index);
    const bit = partitionBits.get(member.partitionId);
    partitionMaskByRoot.set(root, (partitionMaskByRoot.get(root) ?? 0) | bit);
  }
  invariant(
    partitionMaskByRoot.size === documentCount,
    "la unión de memberships no coincide con documents.jsonl",
  );
  const uniqueDocumentCount = partitionMaskByRoot.size;
  aliasOwner.clear();
  documentAliasesByRoot.clear();
  const regionCounts = new Map();
  for (const mask of partitionMaskByRoot.values())
    regionCounts.set(mask, (regionCounts.get(mask) ?? 0) + 1);
  partitionMaskByRoot.clear();
  const membershipRegions = [...regionCounts]
    .map(([mask, count]) => ({
      partitions: expectedPartitions.filter(
        (partition) => (mask & partitionBits.get(partition)) !== 0,
      ),
      documents: count,
    }))
    .sort((a, b) => a.partitions.join("|").localeCompare(b.partitions.join("|")));
  const regionUnion = membershipRegions.reduce((sum, region) => sum + region.documents, 0);
  invariant(regionUnion === uniqueDocumentCount, "ecuación de unión por regiones inválida");

  const supervisor = parseSupervisorLog(await readFile(files.supervisor, "utf8"));
  const discovery = parseDiscoveryLog(await readFile(files.discovery, "utf8"));
  const convergencePass = supervisor.convergedPass;
  const convergenceRecord =
    convergencePass === null ? undefined : supervisor.completePasses.get(convergencePass);
  const observedConvergence =
    convergencePass !== null &&
    convergenceRecord?.newMemberships === 0 &&
    convergenceRecord.partitions === expectedPartitions.length;
  if (convergencePass !== null) {
    const recorded = passCounts.get(convergencePass);
    invariant(recorded !== undefined, "pasada convergente sin memberships observadas");
    invariant(
      expectedPartitions.every((partition) => (recorded.get(partition) ?? 0) > 0),
      "pasada convergente no contiene todas las particiones",
    );
    const derivedNew = memberships.filter((member) => member.firstPass === convergencePass).length;
    invariant(
      derivedNew === convergenceRecord?.newMemberships,
      "new_memberships del supervisor no reconcilia",
    );
  }

  const partitionOutputs = expectedPartitions.map((id) => {
    const logicalMemberships = memberships.filter((member) => member.partitionId === id);
    const totals = discovery.totals.get(id) ?? { initial: [], final: [] };
    const initial = metadata.queryTotals?.[id]?.initial ?? totals.initial[0] ?? null;
    const final = metadata.queryTotals?.[id]?.final ?? totals.final.at(-1) ?? null;
    const regionProjection = membershipRegions
      .filter((region) => region.partitions.includes(id))
      .reduce((sum, region) => sum + region.documents, 0);
    const uniqueRoots = regionProjection;
    const passes = [...passCounts.keys()]
      .sort((a, b) => a - b)
      .flatMap((pass) => {
        const count = passCounts.get(pass)?.get(id);
        if (!count) return [];
        return [
          {
            pass,
            memberships: count,
            newIdentities: logicalMemberships.filter((member) => member.firstPass === pass).length,
          },
        ];
      });
    const finalPassMemberships =
      (convergencePass === null
        ? passes.at(-1)?.memberships
        : passCounts.get(convergencePass)?.get(id)) ?? 0;
    return {
      id,
      queryTotals: { initial, final },
      memberships: logicalMemberships.length,
      uniqueDocuments: uniqueRoots,
      duplicateOccurrences: logicalMemberships.length - uniqueRoots,
      passes,
      finalPassMemberships,
      queryTotalReconciled: final !== null && final === finalPassMemberships,
    };
  });

  const intersections = [];
  for (let left = 0; left < expectedPartitions.length; left += 1) {
    for (let right = left + 1; right < expectedPartitions.length; right += 1) {
      const leftId = expectedPartitions[left];
      const rightId = expectedPartitions[right];
      const count = membershipRegions
        .filter(
          (region) => region.partitions.includes(leftId) && region.partitions.includes(rightId),
        )
        .reduce((sum, region) => sum + region.documents, 0);
      intersections.push({ left: leftId, right: rightId, documents: count });
    }
  }

  const rawMemberships = memberships.length;
  const uniqueDocuments = uniqueDocumentCount;
  const duplicateOccurrences = rawMemberships - uniqueDocuments;
  invariant(
    rawMemberships === uniqueDocuments + duplicateOccurrences,
    "ecuación de deduplicación inválida",
  );
  const published = metadata.publishedGlobalTotal ?? {
    initial: discovery.globals[0] ?? null,
    final: discovery.globals.at(-1) ?? null,
  };
  const inferredCompletePublicCorpus =
    Number.isInteger(published.final) && published.final === uniqueDocuments;
  const suppliedDifference = metadata.notEnumerableWithReason;
  const notEnumerable =
    suppliedDifference?.evidenceStatus === "demonstrated" &&
    Number.isInteger(suppliedDifference.count) &&
    suppliedDifference.reason
      ? suppliedDifference
      : inferredCompletePublicCorpus
        ? {
            count: 0,
            reason: "La unión enumerable coincide exactamente con el contador global final.",
            evidenceStatus: "demonstrated",
          }
        : {
            count: null,
            reason: null,
            evidenceStatus: "not-demonstrated",
          };
  const globalEquation =
    Number.isInteger(published.initial) &&
    Number.isInteger(published.final) &&
    Number.isInteger(notEnumerable.count) &&
    published.final === uniqueDocuments + notEnumerable.count;
  const scopeApproval =
    metadata.scopeApproval ??
    (metadata.authorizedAt
      ? {
          status: "approved",
          approver: "corpus-owner",
          evidence: "run-receipt.authorizedAt",
        }
      : { status: "pending", approver: null, evidence: null });
  const failureReasons = [];
  if (!observedConvergence)
    failureReasons.push("No existe una pasada completa convergente con cero identidades nuevas.");
  for (const partition of partitionOutputs)
    if (!partition.queryTotalReconciled)
      failureReasons.push(`La partición ${partition.id} no reconcilia memberships con queryTotal.`);
  if (scopeApproval.status !== "approved" || !scopeApproval.approver || !scopeApproval.evidence)
    failureReasons.push("Falta aprobación explícita y trazable del alcance.");
  if (
    notEnumerable.evidenceStatus !== "demonstrated" ||
    !Number.isInteger(notEnumerable.count) ||
    !notEnumerable.reason
  )
    failureReasons.push("La diferencia no enumerable no está demostrada.");
  if (!globalEquation)
    failureReasons.push(
      "publishedGlobalTotal no equivale a la unión enumerable más la diferencia demostrada.",
    );
  if (openDetailFailures > 0)
    failureReasons.push(
      `Existen ${String(openDetailFailures)} fallos detail abiertos; el corpus no convergió.`,
    );

  const receipt = {
    schemaVersion: 1,
    kind: "pj-corpus-final-reconciliation",
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    commit: metadata.commit,
    corpusPlan: {
      version: corpusPlan.corpusPlanVersion,
      queryHash: corpusPlan.queryHash,
      fingerprint: corpusPlan.fingerprint,
    },
    inputs: {
      membershipRecords,
      logicalMemberships: memberships.length,
      documents: documentCount,
      manifestEvents,
      manifestCurrentStates: manifestCounts,
      openDetailFailures,
    },
    partitions: partitionOutputs,
    membershipRegions,
    intersections,
    reconciliation: {
      rawMemberships,
      uniqueDocuments,
      duplicateOccurrences,
      regionUnion,
      publishedGlobalTotal: published,
      notEnumerableWithReason: notEnumerable,
      equations: {
        rawEqualsUniquePlusDuplicates: rawMemberships === uniqueDocuments + duplicateOccurrences,
        regionsEqualUniqueDocuments: regionUnion === uniqueDocuments,
        globalEqualsEnumerablePlusClassifiedDifference: globalEquation,
      },
    },
    consistency: {
      strategy: "repeat-complete-pass-until-zero-new-memberships",
      converged: observedConvergence,
      convergedPass: convergencePass,
    },
    scopeApproval,
    privacy: {
      aggregatedOnly: true,
      identifiersEmitted: false,
      sourceRowsEmitted: false,
      urlsEmitted: false,
    },
    status: failureReasons.length === 0 ? "PASS" : "FAIL",
    failureReasons,
  };
  const serialized = JSON.stringify(receipt);
  invariant(!UUID_ANY.test(serialized), "el recibo filtra un UUID");
  return receipt;
}

export async function writeReceiptAtomic(file, receipt) {
  const target = path.resolve(file);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}
