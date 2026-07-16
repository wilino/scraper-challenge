const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const normalize = (value) =>
  String(value).normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  return value;
};
const stable = (value) => JSON.stringify(canonicalize(value));

class DisjointSet {
  constructor(values) {
    this.parent = new Map(values.map((value) => [value, value]));
  }
  find(value) {
    const parent = this.parent.get(value);
    invariant(parent !== undefined, `identidad interna desconocida: ${value}`);
    if (parent !== value) this.parent.set(value, this.find(parent));
    return this.parent.get(value);
  }
  union(left, right) {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) {
      if (a < b) this.parent.set(b, a);
      else this.parent.set(a, b);
    }
  }
}

const parseLines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`NDJSON línea ${index + 1}: ${error.message}`);
      }
    });

const keyOf = ({ partitionId, membershipToken }) => `${partitionId}\u0000${membershipToken}`;

const normalizedIdentity = (identity = {}, sensitive) => {
  const result = {};
  if (identity.documentUuid !== undefined) {
    invariant(UUID.test(identity.documentUuid), "documentUuid inválido");
    result.documentUuid = identity.documentUuid.toLowerCase();
    sensitive.add(identity.documentUuid);
  }
  if (identity.pdfUuid !== undefined) {
    invariant(UUID.test(identity.pdfUuid), "pdfUuid inválido");
    result.pdfUuid = identity.pdfUuid.toLowerCase();
    sensitive.add(identity.pdfUuid);
  }
  if (identity.composite !== undefined) {
    const fields = ["expediente", "fecha", "sala", "tipo", "normalizationVersion"];
    for (const field of fields)
      invariant(
        typeof identity.composite[field] === "string" && identity.composite[field].trim(),
        `composite.${field} inválido`,
      );
    result.composite = fields.map((field) => normalize(identity.composite[field])).join("\u001f");
    for (const field of fields.slice(0, 4)) sensitive.add(identity.composite[field]);
  }
  if (identity.contentHash !== undefined) {
    invariant(
      identity.contentHash.algorithm === "sha256" && SHA256.test(identity.contentHash.value),
      "contentHash inválido",
    );
    invariant(
      typeof identity.contentHash.normalizationVersion === "string" &&
        identity.contentHash.normalizationVersion.trim(),
      "contentHash.normalizationVersion inválido",
    );
    result.contentHash = `${identity.contentHash.value.toLowerCase()}\u001f${normalize(identity.contentHash.normalizationVersion)}`;
    sensitive.add(identity.contentHash.value);
  }
  invariant(Object.keys(result).length > 0, "membership sin candidato de identidad");
  return result;
};

const addAlias = (map, alias, key, dsu) => {
  if (!alias) return;
  const prior = map.get(alias);
  if (prior) dsu.union(prior, key);
  else map.set(alias, key);
};

const sortedUnique = (values) => [...new Set(values)].sort();

export function reconcileNdjson(text) {
  const events = parseLines(text);
  const allowedEventTypes = new Set(["run", "partition", "pass", "membership", "hashReview"]);
  for (const event of events)
    invariant(
      allowedEventTypes.has(event.type),
      `tipo de evento no permitido: ${event.type ?? "<ausente>"}`,
    );
  const runEvents = events.filter(({ type }) => type === "run");
  invariant(runEvents.length === 1, "se requiere exactamente un evento run");
  const run = runEvents[0];
  invariant(run.schemaVersion === 1, "run.schemaVersion inválido");
  invariant(
    ["captured-metadata", "synthetic-contractual"].includes(run.origin),
    "run.origin inválido",
  );
  invariant(typeof run.observed === "boolean", "run.observed inválido");
  invariant(!Number.isNaN(Date.parse(run.capturedAt)), "run.capturedAt inválido");
  invariant(run.commit === null || /^[0-9a-f]{40}$/.test(run.commit), "run.commit inválido");
  invariant(
    Number.isInteger(run.publishedGlobalTotal?.initial) &&
      Number.isInteger(run.publishedGlobalTotal?.final),
    "contador global inválido",
  );

  const partitionEvents = events.filter(({ type }) => type === "partition");
  invariant(partitionEvents.length > 0, "faltan particiones");
  const partitions = new Map();
  for (const partition of partitionEvents) {
    invariant(typeof partition.id === "string" && partition.id, "partition.id inválido");
    invariant(!partitions.has(partition.id), `partición duplicada: ${partition.id}`);
    invariant(
      ["included", "candidate", "subset", "year-shard"].includes(partition.classification),
      `clasificación inválida: ${partition.id}`,
    );
    partitions.set(partition.id, partition);
  }

  const passesByPartition = new Map([...partitions.keys()].map((id) => [id, []]));
  for (const pass of events.filter(({ type }) => type === "pass")) {
    invariant(
      partitions.has(pass.partitionId),
      `pass refiere partición inexistente: ${pass.partitionId}`,
    );
    invariant(Number.isInteger(pass.pass) && pass.pass > 0, "pass inválido");
    invariant(
      Number.isInteger(pass.initialTotal) &&
        pass.initialTotal >= 0 &&
        Number.isInteger(pass.finalTotal) &&
        pass.finalTotal >= 0,
      "totales de pass inválidos",
    );
    invariant(typeof pass.completed === "boolean", "pass.completed inválido");
    passesByPartition.get(pass.partitionId).push({ ...pass, membershipKeys: [] });
  }
  for (const [partitionId, passes] of passesByPartition) {
    passes.sort((a, b) => a.pass - b.pass);
    invariant(passes.length > 0, `partición sin pasadas: ${partitionId}`);
    invariant(
      passes.every((pass, index) => pass.pass === index + 1),
      `pasadas no contiguas: ${partitionId}`,
    );
  }

  const sensitive = new Set();
  const memberships = new Map();
  for (const event of events.filter(({ type }) => type === "membership")) {
    invariant(
      partitions.has(event.partitionId),
      `membership refiere partición inexistente: ${event.partitionId}`,
    );
    invariant(
      typeof event.membershipToken === "string" && event.membershipToken,
      "membershipToken inválido",
    );
    sensitive.add(event.membershipToken);
    const pass = passesByPartition
      .get(event.partitionId)
      .find((candidate) => candidate.pass === event.pass);
    invariant(pass, `membership refiere pasada inexistente: ${event.partitionId}/${event.pass}`);
    const key = keyOf(event);
    const identity = normalizedIdentity(event.identity, sensitive);
    const previous = memberships.get(key);
    if (previous)
      invariant(
        stable(previous.identity) === stable(identity),
        `identidad contradictoria para token en ${event.partitionId}`,
      );
    else
      memberships.set(key, {
        key,
        partitionId: event.partitionId,
        membershipToken: event.membershipToken,
        identity,
      });
    invariant(
      !pass.membershipKeys.includes(key),
      `membership duplicada dentro de pasada: ${event.partitionId}/${event.pass}`,
    );
    pass.membershipKeys.push(key);
  }
  invariant(memberships.size > 0, "faltan memberships");

  const dsu = new DisjointSet([...memberships.keys()]);
  const documentAliases = new Map();
  const pdfAliases = new Map();
  for (const membership of memberships.values()) {
    addAlias(documentAliases, membership.identity.documentUuid, membership.key, dsu);
    addAlias(pdfAliases, membership.identity.pdfUuid, membership.key, dsu);
  }

  const assertNoStrongConflict = () => {
    const documentsByRoot = new Map();
    for (const membership of memberships.values()) {
      if (!membership.identity.documentUuid) continue;
      const root = dsu.find(membership.key);
      if (!documentsByRoot.has(root)) documentsByRoot.set(root, new Set());
      documentsByRoot.get(root).add(membership.identity.documentUuid);
    }
    for (const documents of documentsByRoot.values())
      invariant(documents.size <= 1, "conflicto: un alias PDF enlaza UUIDs de documento distintos");
  };
  assertNoStrongConflict();

  const compositeGroups = new Map();
  for (const membership of memberships.values()) {
    const composite = membership.identity.composite;
    if (!composite) continue;
    if (!compositeGroups.has(composite)) compositeGroups.set(composite, []);
    compositeGroups.get(composite).push(membership.key);
  }
  const compositeResolved = new Set();
  for (const keys of compositeGroups.values()) {
    const roots = new Set(keys.map((key) => dsu.find(key)));
    if (keys.length === 1 || roots.size === 1) keys.forEach((key) => compositeResolved.add(key));
  }

  const hashGroups = new Map();
  for (const membership of memberships.values()) {
    const hash = membership.identity.contentHash;
    if (!hash) continue;
    if (!hashGroups.has(hash)) hashGroups.set(hash, []);
    hashGroups.get(hash).push(membership.key);
  }
  const reviews = new Map();
  for (const review of events.filter(({ type }) => type === "hashReview")) {
    invariant(
      SHA256.test(review.value) && typeof review.normalizationVersion === "string",
      "hashReview inválida",
    );
    const hash = `${review.value.toLowerCase()}\u001f${normalize(review.normalizationVersion)}`;
    invariant(!reviews.has(hash), "hashReview duplicada");
    invariant(
      Array.isArray(review.equivalenceClasses) && review.equivalenceClasses.length > 0,
      "hashReview sin clases",
    );
    invariant(
      typeof review.reviewer === "string" &&
        review.reviewer &&
        typeof review.evidenceRef === "string" &&
        review.evidenceRef,
      "hashReview sin trazabilidad",
    );
    reviews.set(hash, review);
  }
  const hashResolved = new Set();
  let reviewedHashGroups = 0;
  for (const [hash, keys] of hashGroups) {
    const review = reviews.get(hash);
    if (keys.length === 1) {
      if (review) {
        hashResolved.add(keys[0]);
        reviewedHashGroups += 1;
      }
      continue;
    }
    if (!review) continue;
    const reviewedKeys = review.equivalenceClasses.flatMap((group) => group.map(keyOf));
    invariant(reviewedKeys.length === new Set(reviewedKeys).size, "hashReview repite memberships");
    invariant(
      JSON.stringify([...reviewedKeys].sort()) === JSON.stringify([...keys].sort()),
      "hashReview no cubre exactamente el grupo",
    );
    for (const group of review.equivalenceClasses) {
      const groupKeys = group.map(keyOf);
      for (const key of groupKeys)
        invariant(memberships.has(key), "hashReview refiere membership inexistente");
      for (const key of groupKeys.slice(1)) dsu.union(groupKeys[0], key);
      groupKeys.forEach((key) => hashResolved.add(key));
    }
    reviewedHashGroups += 1;
  }
  for (const hash of reviews.keys())
    invariant(hashGroups.has(hash), "hashReview no corresponde a ningún grupo de memberships");
  assertNoStrongConflict();

  const membersByRoot = new Map();
  for (const membership of memberships.values()) {
    const root = dsu.find(membership.key);
    if (!membersByRoot.has(root)) membersByRoot.set(root, []);
    membersByRoot.get(root).push(membership);
  }
  const methodByRoot = new Map();
  for (const [root, members] of membersByRoot) {
    if (members.some(({ identity }) => identity.documentUuid))
      methodByRoot.set(root, "documentUuid");
    else if (members.some(({ identity }) => identity.pdfUuid)) methodByRoot.set(root, "pdfUuid");
    else if (members.some(({ key }) => compositeResolved.has(key)))
      methodByRoot.set(root, "nonCollidingComposite");
    else if (members.some(({ key }) => hashResolved.has(key)))
      methodByRoot.set(root, "reviewedHash");
  }

  const partitionOutputs = [];
  let liveConvergenceObserved = true;
  for (const [partitionId, partition] of [...partitions].sort(([a], [b]) => a.localeCompare(b))) {
    const passes = passesByPartition.get(partitionId);
    const logicalKeys = sortedUnique(passes.flatMap(({ membershipKeys }) => membershipKeys));
    const resolvedKeys = logicalKeys.filter((key) => methodByRoot.has(dsu.find(key)));
    const unresolvedIdentity = logicalKeys.length - resolvedKeys.length;
    const roots = new Set(resolvedKeys.map((key) => dsu.find(key)));
    const seen = new Set();
    const passOutputs = passes.map((pass) => {
      const passRoots = new Set();
      let unresolvedSightings = 0;
      for (const key of pass.membershipKeys) {
        const root = dsu.find(key);
        if (methodByRoot.has(root)) passRoots.add(root);
        else unresolvedSightings += 1;
      }
      const newIdentities =
        unresolvedSightings === 0 ? [...passRoots].filter((root) => !seen.has(root)).length : null;
      passRoots.forEach((root) => seen.add(root));
      return {
        pass: pass.pass,
        initialTotal: pass.initialTotal,
        finalTotal: pass.finalTotal,
        completed: pass.completed,
        newIdentities,
        unresolvedSightings,
      };
    });
    const converged =
      unresolvedIdentity === 0 &&
      passOutputs.at(-1).completed &&
      passOutputs.at(-1).newIdentities === 0;
    if (partition.classification === "included" && !converged) liveConvergenceObserved = false;
    const methodCounts = {
      documentUuid: 0,
      pdfUuid: 0,
      nonCollidingComposite: 0,
      reviewedHash: 0,
      unresolved: unresolvedIdentity,
    };
    for (const key of resolvedKeys) methodCounts[methodByRoot.get(dsu.find(key))] += 1;
    partitionOutputs.push({
      id: partitionId,
      classification: partition.classification,
      queryFingerprint: partition.queryFingerprint ?? null,
      queryTotals: { initial: passes[0].initialTotal, final: passes.at(-1).finalTotal },
      passes: passOutputs,
      enumeration: {
        rawMemberships: logicalKeys.length,
        uniqueDocuments: unresolvedIdentity === 0 ? roots.size : null,
        duplicateOccurrences: unresolvedIdentity === 0 ? logicalKeys.length - roots.size : null,
        enumeratedDocuments: logicalKeys.length,
        withResolvedIdentity: resolvedKeys.length,
        unresolvedIdentity,
        evidenceStatus: unresolvedIdentity === 0 ? "enumerated-resolved" : "enumerated-unresolved",
      },
      identityResolutionCounts: methodCounts,
      finalPassMemberships: new Set(passes.at(-1).membershipKeys).size,
      queryTotalException: partition.queryTotalException ?? null,
      evidence: [...(partition.evidence ?? [])].sort(),
    });
  }

  const includedIds = partitionOutputs
    .filter(({ classification }) => classification === "included")
    .map(({ id }) => id)
    .sort();
  const includedKeys = [...memberships.values()]
    .filter(({ partitionId }) => includedIds.includes(partitionId))
    .map(({ key }) => key);
  const unresolvedIncluded = includedKeys.filter((key) => !methodByRoot.has(dsu.find(key))).length;
  let membershipRegions = [];
  let intersections = [];
  let publiclyEnumerableCorpus = null;
  if (unresolvedIncluded === 0) {
    const partitionsByRoot = new Map();
    for (const key of includedKeys) {
      const root = dsu.find(key);
      if (!partitionsByRoot.has(root)) partitionsByRoot.set(root, new Set());
      partitionsByRoot.get(root).add(memberships.get(key).partitionId);
    }
    const regions = new Map();
    for (const partitionSet of partitionsByRoot.values()) {
      const signature = [...partitionSet].sort().join("\u001f");
      regions.set(signature, (regions.get(signature) ?? 0) + 1);
    }
    membershipRegions = [...regions]
      .map(([signature, documents]) => ({ partitions: signature.split("\u001f"), documents }))
      .sort((a, b) => a.partitions.join("|").localeCompare(b.partitions.join("|")));
    publiclyEnumerableCorpus = [...partitionsByRoot.keys()].length;
    for (let leftIndex = 0; leftIndex < includedIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < includedIds.length; rightIndex += 1) {
        const left = includedIds[leftIndex];
        const right = includedIds[rightIndex];
        const documents = membershipRegions
          .filter(({ partitions: region }) => region.includes(left) && region.includes(right))
          .reduce((sum, region) => sum + region.documents, 0);
        intersections.push({ left, right, documents, evidenceStatus: "identity-derived" });
      }
    }
  }

  const rawMemberships = partitionOutputs
    .filter(({ classification }) => classification === "included")
    .reduce((sum, partition) => sum + partition.enumeration.rawMemberships, 0);
  const notEnumerable = run.notEnumerableWithReason ?? {
    count: null,
    reason: null,
    evidenceStatus: "not-demonstrated",
  };
  const unknownTerms = [];
  if (unresolvedIncluded > 0)
    unknownTerms.push(
      "uniqueDocuments",
      "duplicateOccurrences",
      "publiclyEnumerableCorpus",
      "identity-derived intersections",
    );
  if (notEnumerable.count === null || notEnumerable.evidenceStatus !== "demonstrated")
    unknownTerms.push("notEnumerableWithReason");
  const scopeApproval = run.scopeApproval ?? { status: "pending", approver: null, evidence: null };
  const failureReasons = [];
  if (partitionOutputs.some(({ classification }) => classification !== "included"))
    failureReasons.push("Existen particiones no promovidas a included.");
  if (unresolvedIncluded > 0)
    failureReasons.push(`Quedan ${unresolvedIncluded} memberships sin identidad resuelta.`);
  if (!liveConvergenceObserved)
    failureReasons.push(
      "No todas las particiones incluidas terminaron con una pasada completa sin identidades nuevas.",
    );
  for (const partition of partitionOutputs.filter(
    ({ classification }) => classification === "included",
  )) {
    if (
      partition.finalPassMemberships !== partition.queryTotals.final &&
      !partition.queryTotalException
    )
      failureReasons.push(
        `La última pasada de ${partition.id} no reconcilia con su queryTotal final.`,
      );
  }
  if (!/^[0-9a-f]{40}$/.test(run.commit ?? ""))
    failureReasons.push("La evidencia no está ligada a un commit.");
  if (scopeApproval.status !== "approved" || !scopeApproval.approver || !scopeApproval.evidence)
    failureReasons.push("Falta aprobación explícita del alcance.");
  if (
    notEnumerable.count === null ||
    notEnumerable.evidenceStatus !== "demonstrated" ||
    !notEnumerable.reason
  )
    failureReasons.push("La diferencia no enumerable no está demostrada.");
  if (
    publiclyEnumerableCorpus !== null &&
    run.publishedGlobalTotal.final !== publiclyEnumerableCorpus + notEnumerable.count
  )
    failureReasons.push(
      "El contador global no reconcilia con el corpus enumerable y la diferencia clasificada.",
    );
  const status = failureReasons.length === 0 ? "PASS" : "FAIL";

  const output = {
    schemaVersion: 2,
    origin: run.origin,
    observed: run.observed,
    capturedAt: run.capturedAt,
    commit: run.commit,
    environment: run.environment,
    definitions: run.definitions,
    partitions: partitionOutputs,
    excludedQueries: run.excludedQueries ?? [],
    membershipRegions,
    intersections,
    consistencyStrategy: {
      kind: "repeat-until-no-new-identities",
      liveConvergenceObserved,
      countersRecordedPerPass: true,
    },
    reconciliation: {
      rawMemberships,
      uniqueDocuments: publiclyEnumerableCorpus,
      duplicateOccurrences:
        publiclyEnumerableCorpus === null ? null : rawMemberships - publiclyEnumerableCorpus,
      enumeratedDocuments: rawMemberships,
      withResolvedIdentity: rawMemberships - unresolvedIncluded,
      unresolvedIdentity: unresolvedIncluded,
      publishedGlobalTotal: {
        ...run.publishedGlobalTotal,
        stable: run.publishedGlobalTotal.initial === run.publishedGlobalTotal.final,
      },
      publiclyEnumerableCorpus,
      notEnumerableWithReason: notEnumerable,
      unknownTerms: sortedUnique(unknownTerms),
    },
    identityReviewSummary: { reviewedHashGroups },
    scopeApproval,
    exceptions: run.exceptions ?? [],
    privacy: { identifiersEmitted: false, sourceRowsEmitted: false },
    status,
    failureReasons,
  };

  const serialized = JSON.stringify(output);
  for (const value of sensitive) {
    if (String(value).length >= 6)
      invariant(
        !serialized.includes(String(value)),
        "el recibo filtra un identificador o dato de fila",
      );
  }
  return output;
}

export function serializeReceipt(receipt) {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}
