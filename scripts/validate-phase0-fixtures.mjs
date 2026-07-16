import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { reconcileNdjson } from "./lib/corpus-reconciler.mjs";

const root = process.cwd();
const fixtureRoot = join(root, "test", "fixtures", "pj");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const manifest = JSON.parse(readFileSync(join(fixtureRoot, "fixture-manifest.json"), "utf8"));
assert(manifest.schemaVersion === 3, "manifest: schemaVersion inesperado");
assert(Array.isArray(manifest.files) && manifest.files.length > 0, "manifest: sin archivos");

const allowedOrigins = new Set([
  "captured-structure-synthetic-content",
  "captured-envelope-synthetic-content",
  "captured-metadata",
  "captured-payload-shape",
  "reconstructed-from-observed-controls",
  "synthetic-contractual",
  "fixture-expectations",
  "fixture-manifest",
]);
for (const entry of manifest.files) {
  assert(allowedOrigins.has(entry.origin), `manifest: origen no clasificado en ${entry.path}`);
  if (entry.origin === "synthetic-contractual") {
    assert(
      entry.observed === false,
      `manifest: ${entry.path} sintético debe declarar observed=false`,
    );
  }
}

const manifestPaths = manifest.files.map(({ path }) => path);
assert(new Set(manifestPaths).size === manifestPaths.length, "manifest: rutas duplicadas");

const walk = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const absolute = join(directory, name);
    return statSync(absolute).isDirectory() ? walk(absolute) : [relative(fixtureRoot, absolute)];
  });
const diskPaths = walk(fixtureRoot).sort();
assert(
  JSON.stringify([...manifestPaths].sort()) === JSON.stringify(diskPaths),
  `manifest: inventario distinto al disco\nmanifest=${[...manifestPaths].sort()}\ndisco=${diskPaths}`,
);

const files = new Map(
  manifestPaths.map((path) => [path, readFileSync(join(fixtureRoot, path), "utf8")]),
);
for (const [path, content] of files) {
  assert(content.length > 0, `${path}: vacío`);
  assert(
    !/(?:^|[\r\n])(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)\s*:/i.test(content),
    `${path}: header sensible`,
  );
  assert(!/JSESSIONID\s*[=:]\s*(?!FIXTURE_)/i.test(content), `${path}: sesión reutilizable`);
  assert(
    !/\bBearer\s+\S+|\bBasic\s+[A-Za-z0-9+/=]+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(
      content,
    ),
    `${path}: credencial`,
  );
  assert(!/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(content), `${path}: JWT`);
}
for (const entry of manifest.files) {
  if (
    entry.path.startsWith("requests/") ||
    ["expected.json", "fixture-manifest.json"].includes(entry.path)
  )
    continue;
  assert(
    files.get(entry.path).includes(entry.origin),
    `${entry.path}: clasificación de origen no es autocontenida`,
  );
}

const expected = JSON.parse(files.get("expected.json"));
const initial = files.get("initial.html");
const page1 = files.get("search-page-1.html");
const page2 = files.get("search-page-2.html");
const lastPage = files.get("search-last-page-contract.html");
const partial = files.get("partial-page-2.xml");
const detail = files.get("detail.html");
const detailPartial = files.get("detail-partial.xml");
const superiorPage = files.get("search-superior-page-1.html");
const superiorDetailPartial = files.get("detail-superior-partial.xml");
const partialRedirect = files.get("partial-redirect.xml");
const partialError = files.get("partial-error.xml");

const recordIndexes = (content) =>
  [...content.matchAll(/id="formBuscador:repeat:(\d+):j_idt455"/g)].map((match) =>
    Number(match[1]),
  );
const updateIds = (content) =>
  [...content.matchAll(/<update id="([^"]+)">/g)].map((match) => match[1]);
const controlNames = (content) =>
  new Set(
    [...content.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)].map(
      (match) => match[1],
    ),
  );
const uuids = (content) =>
  [
    ...content.matchAll(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    ),
  ].map((match) => match[0].toLowerCase());
const unique = (values) => new Set(values).size === values.length;
const sameArray = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const recordBlocks = (content) =>
  [...content.matchAll(/<div id="formBuscador:repeat:(\d+):j_idt455"[^>]*>([\s\S]*?)<\/div>/g)].map(
    (match) => ({ index: Number(match[1]), body: match[2] }),
  );
const listFieldNames = (content) =>
  [...content.matchAll(/data-field="([^"]+)"/g)].map((match) => match[1]);
const assertCompleteListRecords = (label, content, indexes) => {
  const records = recordBlocks(content);
  assert(
    sameArray(
      records.map(({ index }) => index),
      indexes,
    ),
    `${label}: bloques de registros incompletos`,
  );
  for (const record of records) {
    const fields = listFieldNames(record.body);
    assert(
      sameArray(fields, expected.listFields),
      `${label}: fila ${record.index} campos incompletos/fuera de orden ${fields}`,
    );
    assert(
      record.body.includes('title="Ver"') && /data-uuid="[^"]+"/.test(record.body),
      `${label}: fila ${record.index} sin descriptor de detalle`,
    );
  }
};

assert(initial.includes('id="formBuscador"'), "initial: falta formBuscador");
assert(
  initial.includes('name="javax.faces.ViewState"') && initial.includes("FIXTURE_VIEWSTATE_0"),
  "initial: falta ViewState 0",
);
assert(page1.includes("FIXTURE_VIEWSTATE_1"), "page1: falta ViewState 1");
assert(page2.includes("FIXTURE_VIEWSTATE_2"), "page2: falta ViewState 2");
assert(page1 !== page2, "page1 y page2 son iguales");

const page1Indexes = recordIndexes(page1);
const page2Indexes = recordIndexes(page2);
const partialIndexes = recordIndexes(partial);
assert(
  sameArray(page1Indexes, expected.pages.page1RecordIndexes),
  `page1: orden/cardinalidad inválidos ${page1Indexes}`,
);
assert(
  sameArray(page2Indexes, expected.pages.page2RecordIndexes),
  `page2: orden/cardinalidad inválidos ${page2Indexes}`,
);
assert(
  sameArray(partialIndexes, expected.pages.page2RecordIndexes),
  `partial: orden/cardinalidad inválidos ${partialIndexes}`,
);
assert(unique(page1Indexes) && unique(page2Indexes), "páginas: índices duplicados");
assert(
  page1Indexes.every((index) => !page2Indexes.includes(index)),
  "páginas: índices solapados",
);
assert(
  page1Indexes.length === expected.pages.pageSize &&
    page2Indexes.length === expected.pages.pageSize,
  "páginas: pageSize inconsistente",
);
assertCompleteListRecords("page1", page1, expected.pages.page1RecordIndexes);
assertCompleteListRecords("page2", page2, expected.pages.page2RecordIndexes);
assertCompleteListRecords("partial-page2", partial, expected.pages.page2RecordIndexes);

assert(
  expected.pages.maxValue === Math.ceil(expected.pages.totalResults / expected.pages.pageSize),
  "expected: maxValue no deriva de total/pageSize",
);
for (const [name, content, currentPage] of [
  ["page1", page1, expected.pages.page1CurrentPage],
  ["page2", page2, expected.pages.page2CurrentPage],
  ["partial", partial, expected.pages.page2CurrentPage],
]) {
  assert(content.includes(`data-current-page="${currentPage}"`), `${name}: currentPage ausente`);
  assert(
    content.includes(`data-max-value="${expected.pages.maxValue}"`),
    `${name}: maxValue ausente`,
  );
  assert(
    content.includes(`"currentPage":${currentPage}`),
    `${name}: currentPage no preservado en configuración RichFaces`,
  );
  assert(
    content.includes(`"maxValue":${expected.pages.maxValue}`),
    `${name}: maxValue no preservado en configuración RichFaces`,
  );
}

const lastContract = expected.pages.lastPageContract;
assert(
  lastPage.includes(`data-origin="${lastContract.origin}"`) &&
    lastPage.includes('data-observed="true"'),
  "última página: evidencia observada no etiquetada",
);
assert(lastContract.observed === true, "última página: debe declararse observada");
assert(
  lastContract.currentPage === expected.pages.maxValue &&
    lastContract.maxValue === expected.pages.maxValue,
  "última página: límites incoherentes",
);
assert(
  lastPage.includes(`data-current-page="${lastContract.currentPage}"`) &&
    lastPage.includes(`data-max-value="${lastContract.maxValue}"`),
  "última página: scroller incoherente",
);
assert(
  sameArray(recordIndexes(lastPage), lastContract.observedRecordIndexes),
  "última página: índices observados incoherentes",
);
assert(
  lastContract.observedRecordIndexes[0] === expected.pages.totalResults - 1,
  "última página: índice final no reconcilia con el total",
);
assertCompleteListRecords("last-page", lastPage, lastContract.observedRecordIndexes);
assert(
  !lastPage.includes("data1_ds_next") && !lastPage.includes("data1_ds_l"),
  "última página: conserva acciones next/last",
);

for (const content of [page1, page2]) {
  const names = controlNames(content);
  for (const name of expected.form.requiredResultControls) {
    assert(names.has(name), `formulario de resultados: falta control ${name}`);
  }
}

assert(
  partial.startsWith("<?xml") &&
    partial.includes("<partial-response>") &&
    partial.includes("<changes>"),
  "partial: envelope JSF incompleto",
);
assert(
  sameArray(updateIds(partial), expected.partialUpdates),
  `partial: updates fuera de orden ${updateIds(partial)}`,
);
assert(
  partial.includes('<update id="javax.faces.ViewState"><![CDATA[FIXTURE_VIEWSTATE_2]]>'),
  "partial: salida ViewState 2 inválida",
);
assert(
  partial.includes("'parameters':{'uuid':") && partial.includes('onclick="RichFaces.ajax('),
  "partial: forma del postback de detalle ausente",
);

assert(
  detail.includes("DATOS DE LA RESOLUCIÓN:") &&
    detail.includes("DATOS DEL PROCESO:") &&
    detail.includes("DATOS DE PROCEDENCIA:"),
  "detail: secciones incompletas",
);
assert(
  detail.includes(`/jurisprudenciaweb/ServletDescarga?uuid=${expected.syntheticUuid.pdf}`),
  "detail: descriptor PDF ausente",
);
assert(
  detail.includes(`/jurisprudenciaweb/ServletDescarga?uuid=${expected.syntheticUuid.word}`),
  "detail: descriptor Word ausente",
);
assert(
  detailPartial.startsWith("<?xml") &&
    detailPartial.includes("<partial-response>") &&
    detailPartial.includes("<changes>"),
  "detail-partial: envelope JSF incompleto",
);
assert(
  sameArray(updateIds(detailPartial), expected.detailPartial.updates),
  "detail-partial: updates u orden inválidos",
);
assert(
  detailPartial.includes(
    `<update id="javax.faces.ViewState"><![CDATA[${expected.detailPartial.outputViewState}]]>`,
  ),
  "detail-partial: transición ViewState inválida",
);
for (const section of ["DATOS DE LA RESOLUCIÓN:", "DATOS DEL PROCESO:", "DATOS DE PROCEDENCIA:"]) {
  assert(detailPartial.includes(section), `detail-partial: falta sección ${section}`);
}
for (const label of expected.detailLabels) {
  assert(detail.includes(`<dt>${label}</dt>`), `detail: falta campo inventariado ${label}`);
  assert(
    detailPartial.includes(`<dt>${label}</dt>`),
    `detail-partial: falta campo inventariado ${label}`,
  );
}
for (const [kind, uuid] of [
  ["pdf", expected.syntheticUuid.pdf],
  ["word", expected.syntheticUuid.word],
]) {
  const descriptor = `data-file-type="${kind}" href="/jurisprudenciaweb/ServletDescarga?uuid=${uuid}"`;
  assert(detailPartial.includes(descriptor), `detail-partial: descriptor ${kind} ausente`);
}

assert(
  superiorPage.includes('data-corte="superior"') && superiorPage.includes("formBuscador:buCorte"),
  "superior-list: corte no identificada",
);
assertCompleteListRecords("superior-list", superiorPage, expected.superior.recordIndexes);
assert(
  superiorPage.includes(`:${expected.superior.detailSourceSuffix}"`) &&
    superiorPage.includes(`data-uuid="${expected.syntheticUuid.superiorDocument}"`),
  "superior-list: source/UUID de detalle ausente",
);
assert(
  superiorDetailPartial.startsWith("<?xml") && superiorDetailPartial.includes("<partial-response>"),
  "superior-detail: envelope JSF ausente",
);
assert(
  sameArray(updateIds(superiorDetailPartial), expected.superior.updates),
  "superior-detail: updates fuera de orden",
);
assert(
  superiorDetailPartial.includes(`<update id="${expected.superior.popupId}">`) &&
    superiorDetailPartial.includes(expected.superior.outputViewState),
  "superior-detail: popup/ViewState inválidos",
);
for (const label of expected.superior.variantLabels) {
  assert(
    superiorDetailPartial.includes(`<dt>${label}</dt>`),
    `superior-detail: falta variante ${label}`,
  );
}
for (const [kind, uuid] of [
  ["pdf", expected.syntheticUuid.superiorPdf],
  ["word", expected.syntheticUuid.superiorWord],
]) {
  assert(
    superiorDetailPartial.includes(
      `data-file-type="${kind}" href="/jurisprudenciaweb/ServletDescarga?uuid=${uuid}"`,
    ),
    `superior-detail: descriptor ${kind} ausente`,
  );
}

assert(
  partialRedirect.includes("origin: synthetic-contractual") &&
    partialRedirect.includes(`<redirect url="${expected.partialNodeFixtures.redirect.url}"/>`),
  "partial-redirect: clasificación/nodo inválidos",
);
assert(
  partialError.includes("origin: synthetic-contractual") &&
    partialError.includes(`<error-name>${expected.partialNodeFixtures.error.name}</error-name>`) &&
    partialError.includes("<error-message><![CDATA["),
  "partial-error: clasificación/nodos inválidos",
);
const invalidViewState = JSON.parse(files.get("invalid-viewstate-response.json"));
for (const key of ["origin", "status", "contentType", "bodyBytes", "classification"]) {
  assert(
    invalidViewState[key] === expected.invalidViewState[key],
    `invalid-viewstate: ${key} inválido`,
  );
}
assert(
  invalidViewState.bodyVersioned === false,
  "invalid-viewstate: cuerpo vacío no debe fingirse como fixture XML",
);

const searchRequest = new URLSearchParams(files.get("requests/search-page-1.urlencoded").trim());
const pageRequest = new URLSearchParams(files.get("requests/page-2.urlencoded").trim());
const detailRequest = new URLSearchParams(files.get("requests/detail.urlencoded").trim());
const universeRequests = new Map(
  expected.universe.partitions.map((partition) => [
    partition.name,
    new URLSearchParams(files.get(`requests/universe-${partition.name}.urlencoded`).trim()),
  ]),
);
assert(
  searchRequest.get("javax.faces.ViewState") === "FIXTURE_VIEWSTATE_0",
  "request búsqueda: transición inválida",
);
assert(
  pageRequest.get("javax.faces.ViewState") === expected.pages.page1ViewState,
  "request página 2: transición inválida",
);
assert(pageRequest.get("formBuscador:data1:page") === "2", "request página 2: falta page=2");
assert(
  detailRequest.get("javax.faces.ViewState") === expected.detailPartial.inputViewState,
  "request detalle: transición inválida",
);
assert(
  detailRequest.get("uuid") === expected.syntheticUuid.document,
  "request detalle: UUID sintético inválido",
);
assert(
  detailRequest.get("javax.faces.source") === "formBuscador:repeat:10:j_idt491",
  "request detalle: source inesperado",
);

const generatedAjaxParameters = new Set([
  "javax.faces.source",
  "javax.faces.partial.event",
  "javax.faces.partial.execute",
  "javax.faces.partial.render",
  "javax.faces.partial.ajax",
  "org.richfaces.ajax.component",
  "AJAX:EVENTS_COUNT",
  "formBuscador:data1",
  "formBuscador:data1:page",
  "formBuscador:repeat:10:j_idt491",
  "uuid",
  "recurso",
  "nroexp",
  "palabras",
  "pretensiones",
  "normaDI",
  "tipoResolucion",
  "fechaResolucion",
  "sala",
  "sumilla",
]);
for (const [label, request, html] of [
  ["página 2", pageRequest, page1],
  ["detalle", detailRequest, page2],
]) {
  const names = controlNames(html);
  for (const key of new Set(request.keys())) {
    if (!generatedAjaxParameters.has(key))
      assert(names.has(key), `request ${label}: ${key} no es serializable desde el formulario`);
    assert(request.getAll(key).length === 1, `request ${label}: parámetro duplicado ${key}`);
  }
}
const initialNames = controlNames(initial);
for (const key of new Set(searchRequest.keys())) {
  assert(
    initialNames.has(key) || initial.includes(`'${key}'`) || initial.includes(`"${key}"`),
    `request búsqueda: ${key} no proviene del formulario/submit JSF`,
  );
  assert(searchRequest.getAll(key).length === 1, `request búsqueda: parámetro duplicado ${key}`);
}

const universeFilterKeys = [
  "formBuscador:txtBusqueda",
  "formBuscador:buPretensionDelitoSupValue",
  "formBuscador:buPretensionDelitoSupInput",
  "formBuscador:buPretensionValue",
  "formBuscador:buPretensionInput",
  "formBuscador:buPalabraClaveValue",
  "formBuscador:buPalabraClaveInput",
  "formBuscador:buNroExpediente",
  "formBuscador:buAnio",
];
const universeKeySets = [];
let partitionSum = 0;
for (const partition of expected.universe.partitions) {
  const request = universeRequests.get(partition.name);
  const receipt = JSON.parse(files.get(`universe-${partition.name}-receipt.json`));
  universeKeySets.push([...request.keys()]);
  assert(
    request.get("javax.faces.ViewState") === "FIXTURE_VIEWSTATE_UNIVERSE",
    `universo ${partition.name}: ViewState no redactado`,
  );
  assert(
    request.get("formBuscador:tabpanel-value") === "especializada",
    `universo ${partition.name}: pestaña incorrecta`,
  );
  assert(
    request.get("formBuscador:buCorte") === partition.corte,
    `universo ${partition.name}: corte incorrecta`,
  );
  assert(
    request.get("formBuscador:buDistrito") === "0" &&
      request.get("formBuscador:buEspecialidad") === "0" &&
      request.get("formBuscador:buSala") === "0",
    `universo ${partition.name}: filtros categóricos no vacíos`,
  );
  for (const key of universeFilterKeys)
    assert(request.get(key) === "", `universo ${partition.name}: filtro ${key} no vacío`);
  assert(
    request.get("formBuscador:varAutos2") === "on",
    `universo ${partition.name}: autos no incluidos`,
  );
  assert(
    request.get("formBuscador:buOrden") === "21" &&
      request.get("formBuscador:buOrdenForma") === "DESC",
    `universo ${partition.name}: orden no reproducible`,
  );
  assert(
    receipt.origin === "captured-metadata" && receipt.observed === true,
    `universo ${partition.name}: recibo no observado`,
  );
  assert(
    receipt.payloadShape === expected.universe.payloadShape,
    `universo ${partition.name}: origen del payload ambiguo`,
  );
  assert(
    receipt.query.corte === Number(partition.corte) &&
      receipt.query.emptyFilters === true &&
      receipt.query.includeAutos === true &&
      receipt.query.order === "DESC",
    `universo ${partition.name}: consulta del recibo incoherente`,
  );
  if (partition.name === "superior") {
    assert(
      receipt.query.autosParameterSource === "reconstructed-not-visible-after-corte-selection",
      "universo superior: parámetro autos presentado como control UI visible",
    );
  }
  assert(
    receipt.status === 200 && receipt.reportedGlobalTotal === expected.universe.globalTotal,
    `universo ${partition.name}: status/global inválido`,
  );
  assert(
    receipt.queryResults === partition.results && receipt.pages === partition.pages,
    `universo ${partition.name}: totales distintos`,
  );
  assert(
    receipt.pages === Math.ceil(receipt.queryResults / receipt.pageSize),
    `universo ${partition.name}: páginas no derivan del total`,
  );
  partitionSum += receipt.queryResults;
}
assert(
  sameArray(universeKeySets[0], universeKeySets[1]),
  "universo: payloads no tienen la misma forma",
);
assert(partitionSum === expected.universe.partitionSum, "universo: suma de particiones inválida");
assert(
  expected.universe.globalTotal - partitionSum === expected.universe.unreconciled,
  "universo: brecha inválida",
);

const arbitration = JSON.parse(files.get("universe-laudos-receipt.json"));
const arbitrationExpected = expected.universe.historicalArbitration;
assert(
  arbitration.origin === "captured-metadata" && arbitration.observed === true,
  "laudos: recibo no observado",
);
assert(
  arbitration.allYearsResults === arbitrationExpected.results &&
    arbitration.pageSize === arbitrationExpected.pageSize,
  "laudos: total/pageSize inválidos",
);
assert(
  arbitration.export.status === 200 &&
    arbitration.export.contentType === "application/vnd.ms-excel" &&
    arbitration.export.bodyVersioned === false,
  "laudos: export inválido o cuerpo versionado",
);
assert(
  arbitration.rowIdentityObserved === "ServletDescarga.uuid",
  "laudos: clave de identidad no registrada",
);
assert(
  arbitration.intersectionWithMainPartitions.requiredForFullReconciliation ===
    arbitrationExpected.requiredOverlap,
  "laudos: intersección requerida incoherente",
);
assert(
  arbitration.intersectionWithMainPartitions.observed === arbitrationExpected.overlapObserved,
  "laudos: inferencia presentada como observación",
);
assert(
  arbitration.allYearsResults - expected.universe.unreconciled ===
    arbitrationExpected.requiredOverlap,
  "laudos: aritmética de cobertura inválida",
);
for (const key of [
  "formBusqueda",
  "javax.faces.ViewState",
  "formBusqueda:j_idt64",
  "forward",
  "busqueda",
]) {
  assert(
    arbitration.searchRequestFieldNames.includes(key),
    `laudos: falta campo de búsqueda ${key}`,
  );
}
for (const key of ["formBusqueda", "javax.faces.ViewState", "formBusqueda:j_idt57"]) {
  assert(
    arbitration.export.requestFieldNames.includes(key),
    `laudos: falta campo de exportación ${key}`,
  );
}

const reconciliationAttempt = JSON.parse(files.get("universe-reconciliation-attempt.json"));
const attemptExpected = expected.universe.latestReconciliationAttempt;
assert(
  reconciliationAttempt.origin === "captured-metadata" && reconciliationAttempt.observed === true,
  "reconciliación: intento no observado",
);
assert(
  reconciliationAttempt.browser.mainSuperior.autosControlVisibleAfterCorteSelection === false,
  "reconciliación: visibilidad de autos Superior incorrecta",
);
assert(
  reconciliationAttempt.browser.mainSuperior.queryResults === attemptExpected.mainSuperiorResults,
  "reconciliación: total Superior del navegador inválido",
);
assert(
  reconciliationAttempt.curl.mainSuperior.validTabularExport === false &&
    reconciliationAttempt.curl.mainSuperior.exportContentType === "text/html",
  "reconciliación: respuesta HTML presentada como export",
);
assert(
  reconciliationAttempt.curl.historicalArbitration.searchStatus === 500 &&
    reconciliationAttempt.curl.historicalArbitration.searchBodyBytes === 0,
  "reconciliación: fallo de laudos no preservado",
);
for (const key of [
  "reportedGlobalTotal",
  "mainPartitionSum",
  "historicalResults",
  "requiredHistoricalOverlap",
  "overlapObserved",
  "classification",
]) {
  const expectedKey =
    { reportedGlobalTotal: "globalTotal", requiredHistoricalOverlap: "requiredOverlap" }[key] ??
    key;
  assert(
    reconciliationAttempt.reconciliation[key] === attemptExpected[expectedKey],
    `reconciliación: ${key} incoherente`,
  );
}
assert(
  reconciliationAttempt.reconciliation.reportedGlobalTotal -
    reconciliationAttempt.reconciliation.mainPartitionSum ===
    expected.universe.unreconciled,
  "reconciliación: brecha no deriva del intento actual",
);
assert(
  reconciliationAttempt.sensitiveBodiesVersioned === false,
  "reconciliación: cuerpos sensibles versionados",
);

const reconciliationRetry = JSON.parse(files.get("universe-reconciliation-retry.json"));
const retryExpected = expected.universe.reconciliationRetry;
assert(
  reconciliationRetry.origin === "captured-metadata" && reconciliationRetry.observed === true,
  "reintento: evidencia no observada",
);
assert(
  reconciliationRetry.snapshot.startingGlobalTotal === retryExpected.startingGlobalTotal &&
    reconciliationRetry.snapshot.endingGlobalTotal === retryExpected.endingGlobalTotal,
  "reintento: mutación global no registrada",
);
assert(
  reconciliationRetry.snapshot.stableDuringAttempt === false,
  "reintento: instantánea inestable presentada como estable",
);
assert(
  reconciliationRetry.historicalArbitration.queryResults === retryExpected.historicalResults &&
    reconciliationRetry.historicalArbitration.dataRows === retryExpected.historicalRows,
  "reintento: export histórico incompleto",
);
assert(
  reconciliationRetry.historicalArbitration.ole2Signature === true &&
    reconciliationRetry.historicalArbitration.uuidOccurrences === 0,
  "reintento: formato/identidad histórica incorrectos",
);
assert(
  reconciliationRetry.historicalArbitration.compositeIdentity.uniqueKeys ===
    retryExpected.historicalUniqueCompositeKeys,
  "reintento: claves históricas incoherentes",
);
assert(
  reconciliationRetry.mainSuperior.queryResults === retryExpected.mainSuperiorResults &&
    reconciliationRetry.mainSuperior.validTabularExport === false,
  "reintento: export principal presentado como válido",
);
assert(
  reconciliationRetry.annualProbe2026.queryResults === retryExpected.annual2026Results &&
    reconciliationRetry.annualProbe2026.fullSuccessfulControlsAttempt.validTabularExport === false,
  "reintento: sonda anual incoherente",
);
assert(
  reconciliationRetry.modernCommercial2025.queryResults ===
    retryExpected.modernCommercial2025Results &&
    reconciliationRetry.modernCommercial2025.classification === "main-superior-commercial-subset",
  "reintento: ruta comercial mal clasificada",
);
assert(
  reconciliationRetry.reconciliation.requiredHistoricalOverlap === retryExpected.requiredOverlap &&
    reconciliationRetry.reconciliation.overlapObserved === retryExpected.overlapObserved,
  "reintento: solapamiento inferido presentado como observado",
);
assert(
  reconciliationRetry.reconciliation.classification === retryExpected.classification &&
    reconciliationRetry.reconciliation.comparableMainRowsAvailable === false,
  "reintento: clasificación final incoherente",
);
assert(
  reconciliationRetry.sensitiveBodiesVersioned === false &&
    reconciliationRetry.historicalArbitration.bodyVersioned === false,
  "reintento: cuerpos sensibles versionados",
);

// Fase 0.1: el esquema y el recibo deben representar también un resultado FAIL
// sin convertir ausencia de evidencia en ceros ni en una reconciliación ficticia.
const reconciliationSchema = JSON.parse(files.get("corpus-reconciliation.schema.json"));
assert(
  reconciliationSchema.$schema === "https://json-schema.org/draft/2020-12/schema",
  "corpus: dialecto de esquema inesperado",
);
assert(
  reconciliationSchema.schemaVersion === 2 &&
    JSON.stringify(reconciliationSchema.supportedReceiptVersions) === JSON.stringify([1, 2]),
  "corpus: versión de esquema inesperada",
);
assert(
  reconciliationSchema.origin === "synthetic-contractual" &&
    reconciliationSchema.observed === false,
  "corpus: esquema contractual mal clasificado",
);

const corpusReceipt = JSON.parse(files.get("corpus-reconciliation-receipt.json"));
const requiredReceiptKeys = [
  "schemaVersion",
  "origin",
  "observed",
  "capturedAt",
  "commit",
  "environment",
  "definitions",
  "partitions",
  "excludedQueries",
  "intersections",
  "consistencyStrategy",
  "reconciliation",
  "scopeApproval",
  "exceptions",
  "status",
  "failureReasons",
];
for (const key of requiredReceiptKeys)
  assert(Object.hasOwn(corpusReceipt, key), `corpus: falta ${key}`);
assert(
  corpusReceipt.schemaVersion === 1 &&
    corpusReceipt.origin === "captured-metadata" &&
    corpusReceipt.observed === true,
  "corpus: recibo/versionado de origen inválido",
);
assert(!Number.isNaN(Date.parse(corpusReceipt.capturedAt)), "corpus: capturedAt inválido");
assert(
  corpusReceipt.commit === null || /^[0-9a-f]{40}$/.test(corpusReceipt.commit),
  "corpus: commit debe ser SHA-1 completo o null",
);
assert(
  corpusReceipt.environment.country === "Peru" &&
    corpusReceipt.environment.access === "authorized-direct",
  "corpus: entorno no registrado",
);
for (const term of [
  "publishedGlobalTotal",
  "queryTotal",
  "publiclyEnumerableCorpus",
  "notEnumerableWithReason",
]) {
  assert(
    typeof corpusReceipt.definitions[term] === "string" &&
      corpusReceipt.definitions[term].length > 0,
    `corpus: definición ausente ${term}`,
  );
}
assert(
  /no es una particici[oó]n navegable|no es una partición navegable/i.test(
    corpusReceipt.definitions.publishedGlobalTotal,
  ),
  "corpus: contador global confundido con partición",
);

const isCount = (value) => Number.isInteger(value) && value >= 0;
const nullableCounts = [
  "rawMemberships",
  "uniqueDocuments",
  "duplicateOccurrences",
  "enumeratedDocuments",
  "withResolvedIdentity",
  "unresolvedIdentity",
];
assert(
  Array.isArray(corpusReceipt.partitions) && corpusReceipt.partitions.length >= 3,
  "corpus: faltan particiones candidatas",
);
assert(unique(corpusReceipt.partitions.map(({ id }) => id)), "corpus: IDs de partición duplicados");
for (const partition of corpusReceipt.partitions) {
  assert(
    ["candidate", "included", "subset", "year-shard"].includes(partition.classification),
    `corpus ${partition.id}: clasificación inválida`,
  );
  assert(
    isCount(partition.queryTotals.initial) && isCount(partition.queryTotals.final),
    `corpus ${partition.id}: queryTotal inválido`,
  );
  for (const key of nullableCounts)
    assert(
      partition.enumeration[key] === null || isCount(partition.enumeration[key]),
      `corpus ${partition.id}: ${key} inválido`,
    );
  const {
    rawMemberships,
    uniqueDocuments,
    duplicateOccurrences,
    enumeratedDocuments,
    withResolvedIdentity,
    unresolvedIdentity,
  } = partition.enumeration;
  if ([rawMemberships, uniqueDocuments, duplicateOccurrences].every(isCount)) {
    assert(
      rawMemberships === uniqueDocuments + duplicateOccurrences,
      `corpus ${partition.id}: ecuación de membresías inválida`,
    );
  }
  if ([enumeratedDocuments, withResolvedIdentity, unresolvedIdentity].every(isCount)) {
    assert(
      enumeratedDocuments === withResolvedIdentity + unresolvedIdentity,
      `corpus ${partition.id}: ecuación de identidad inválida`,
    );
  }
  if (partition.enumeration.evidenceStatus === "enumerated-resolved") {
    assert(
      unresolvedIdentity === 0 &&
        [rawMemberships, uniqueDocuments, duplicateOccurrences].every(isCount),
      `corpus ${partition.id}: resolución completa no demostrada`,
    );
  }
  assert(
    Array.isArray(partition.evidence) && partition.evidence.length > 0,
    `corpus ${partition.id}: evidencia ausente`,
  );
}

const historicalPartition = corpusReceipt.partitions.find(
  ({ id }) => id === "historical-arbitration-lima",
);
assert(historicalPartition, "corpus: falta colección histórica");
const historicalIdentity = historicalPartition.identity;
const collidingRows =
  historicalIdentity.duplicateKeyGroups + historicalIdentity.duplicateOccurrencesBeyondFirst;
assert(collidingRows === 268, "corpus: filas históricas colisionadas mal derivadas");
assert(
  historicalIdentity.nonCollidingCompositeRows ===
    historicalPartition.enumeration.enumeratedDocuments - collidingRows,
  "corpus: filas históricas no colisionadas incoherentes",
);
assert(
  historicalPartition.enumeration.withResolvedIdentity ===
    historicalIdentity.nonCollidingCompositeRows,
  "corpus: identidades históricas resueltas incoherentes",
);
assert(
  historicalPartition.enumeration.unresolvedIdentity === collidingRows,
  "corpus: colisiones históricas presentadas como resueltas",
);
assert(
  historicalPartition.enumeration.uniqueDocuments === null &&
    historicalPartition.enumeration.duplicateOccurrences === null,
  "corpus: claves XLS confundidas con documentos únicos",
);

const includedQueryTotals = corpusReceipt.partitions
  .filter(({ classification }) => ["candidate", "included"].includes(classification))
  .map(({ queryTotals }) => queryTotals.final);
assert(
  corpusReceipt.reconciliation.queryRawMemberships ===
    includedQueryTotals.reduce((sum, value) => sum + value, 0),
  "corpus: suma cruda de queryTotals inválida",
);
assert(
  corpusReceipt.excludedQueries.some(
    ({ id, classification }) => id === "modern-commercial-2025" && classification === "subset",
  ),
  "corpus: ruta comercial no excluida como subconjunto",
);
assert(
  corpusReceipt.excludedQueries.some(
    ({ classification, reason }) =>
      classification === "year-shard" && /no se demostr[oó]/i.test(reason),
  ),
  "corpus: sonda anual presentada como partición equivalente",
);

const hypotheticalOverlap = corpusReceipt.intersections.find(
  ({ evidenceStatus }) => evidenceStatus === "hypothesis",
);
assert(hypotheticalOverlap?.documents === 146, "corpus: hipótesis de solapamiento no preservada");
assert(
  !corpusReceipt.intersections.some(
    ({ documents, evidenceStatus }) => isCount(documents) && evidenceStatus === "identity-derived",
  ),
  "corpus: intersección por identidad inventada",
);

const global = corpusReceipt.reconciliation;
if ([global.rawMemberships, global.uniqueDocuments, global.duplicateOccurrences].every(isCount)) {
  assert(
    global.rawMemberships === global.uniqueDocuments + global.duplicateOccurrences,
    "corpus: ecuación global de membresías inválida",
  );
}
if (
  [global.enumeratedDocuments, global.withResolvedIdentity, global.unresolvedIdentity].every(
    isCount,
  )
) {
  assert(
    global.enumeratedDocuments === global.withResolvedIdentity + global.unresolvedIdentity,
    "corpus: ecuación global de identidad inválida",
  );
}
assert(
  global.publishedGlobalTotal.initial !== global.publishedGlobalTotal.final &&
    global.publishedGlobalTotal.stable === false,
  "corpus: drift observado ocultado",
);
assert(
  global.notEnumerableWithReason.evidenceStatus === "not-demonstrated" &&
    global.notEnumerableWithReason.count === null,
  "corpus: brecha presentada como no enumerable sin prueba",
);
const nullGlobalTerms = nullableCounts.filter((key) => global[key] === null);
for (const term of nullGlobalTerms)
  assert(global.unknownTerms.includes(term), `corpus: término null sin clasificar ${term}`);
if (global.publiclyEnumerableCorpus === null)
  assert(
    global.unknownTerms.includes("publiclyEnumerableCorpus"),
    "corpus: corpus enumerable null sin clasificar",
  );
if (global.notEnumerableWithReason.count === null)
  assert(
    global.unknownTerms.includes("notEnumerableWithReason"),
    "corpus: diferencia null sin clasificar",
  );

assert(
  corpusReceipt.consistencyStrategy.kind === "repeat-until-no-new-identities",
  "corpus: estrategia de consistencia inválida",
);
assert(
  corpusReceipt.consistencyStrategy.replay === "test/fixtures/pj/corpus-mutation-replay.json",
  "corpus: replay no enlazado",
);
assert(
  Array.isArray(corpusReceipt.membershipRegions) && corpusReceipt.membershipRegions.length === 0,
  "corpus FAIL: no debe inventar regiones de membresía",
);
assert(
  corpusReceipt.privacy.identifiersEmitted === false &&
    corpusReceipt.privacy.sourceRowsEmitted === false,
  "corpus: declaración de privacidad inválida",
);

const derivedSyntheticReceipt = reconcileNdjson(files.get("corpus-reconciliation-input.ndjson"));
assert(
  derivedSyntheticReceipt.schemaVersion === 2 && derivedSyntheticReceipt.status === "PASS",
  "corpus derivado: fixture sintético no reconcilia",
);
assert(
  derivedSyntheticReceipt.reconciliation.rawMemberships === 9 &&
    derivedSyntheticReceipt.reconciliation.uniqueDocuments === 5 &&
    derivedSyntheticReceipt.reconciliation.duplicateOccurrences === 4,
  "corpus derivado: ecuación global inválida",
);
assert(
  derivedSyntheticReceipt.reconciliation.enumeratedDocuments === 9 &&
    derivedSyntheticReceipt.reconciliation.withResolvedIdentity === 9 &&
    derivedSyntheticReceipt.reconciliation.unresolvedIdentity === 0,
  "corpus derivado: ecuación de identidad inválida",
);
assert(
  derivedSyntheticReceipt.membershipRegions.reduce((sum, region) => sum + region.documents, 0) ===
    derivedSyntheticReceipt.reconciliation.publiclyEnumerableCorpus,
  "corpus derivado: regiones no recalculan la unión",
);
for (const intersection of derivedSyntheticReceipt.intersections) {
  const derived = derivedSyntheticReceipt.membershipRegions
    .filter(
      ({ partitions }) =>
        partitions.includes(intersection.left) && partitions.includes(intersection.right),
    )
    .reduce((sum, region) => sum + region.documents, 0);
  assert(
    intersection.documents === derived,
    `corpus derivado: intersección ${intersection.left}/${intersection.right} no recalculable`,
  );
}

// Un PASS solo es válido con evidencia cerrada; el recibo actual debe fallar de
// forma explicable, no por relajación del validador.
if (corpusReceipt.status === "PASS") {
  assert(/^[0-9a-f]{40}$/.test(corpusReceipt.commit), "corpus PASS: falta commit");
  assert(
    corpusReceipt.scopeApproval.status === "approved" &&
      corpusReceipt.scopeApproval.approver &&
      corpusReceipt.scopeApproval.evidence,
    "corpus PASS: falta aprobación explícita",
  );
  assert(global.unknownTerms.length === 0, "corpus PASS: conserva términos desconocidos");
  assert(
    [
      global.rawMemberships,
      global.uniqueDocuments,
      global.duplicateOccurrences,
      global.enumeratedDocuments,
      global.withResolvedIdentity,
      global.unresolvedIdentity,
      global.publiclyEnumerableCorpus,
    ].every(isCount),
    "corpus PASS: ecuaciones incompletas",
  );
  assert(global.unresolvedIdentity === 0, "corpus PASS: identidad no resuelta");
  assert(
    corpusReceipt.partitions.every(
      ({ classification, enumeration }) =>
        classification === "included" && enumeration.evidenceStatus === "enumerated-resolved",
    ),
    "corpus PASS: partición candidata/no resuelta",
  );
  assert(
    corpusReceipt.intersections.every(
      ({ documents, evidenceStatus }) =>
        isCount(documents) && evidenceStatus === "identity-derived",
    ),
    "corpus PASS: intersecciones no derivadas de identidad",
  );
  assert(
    corpusReceipt.consistencyStrategy.liveConvergenceObserved === true,
    "corpus PASS: convergencia live no observada",
  );
  assert(
    isCount(global.notEnumerableWithReason.count) &&
      global.notEnumerableWithReason.evidenceStatus === "demonstrated" &&
      global.notEnumerableWithReason.reason,
    "corpus PASS: diferencia global sin demostrar",
  );
  assert(
    global.publishedGlobalTotal.final ===
      global.publiclyEnumerableCorpus + global.notEnumerableWithReason.count,
    "corpus PASS: contador global no reconciliado",
  );
  assert(corpusReceipt.failureReasons.length === 0, "corpus PASS: conserva motivos de fallo");
} else {
  assert(corpusReceipt.status === "FAIL", "corpus: estado final inválido");
  assert(
    Array.isArray(corpusReceipt.failureReasons) && corpusReceipt.failureReasons.length > 0,
    "corpus FAIL: faltan motivos",
  );
  assert(global.unknownTerms.length > 0, "corpus FAIL: no identifica términos abiertos");
}

const mutationReplay = JSON.parse(files.get("corpus-mutation-replay.json"));
assert(
  mutationReplay.origin === "synthetic-contractual" && mutationReplay.observed === false,
  "replay: evidencia sintética mal clasificada",
);
assert(
  mutationReplay.strategy === corpusReceipt.consistencyStrategy.kind,
  "replay: estrategia distinta al recibo",
);
assert(
  isCount(mutationReplay.pageSize) && mutationReplay.pageSize > 0,
  "replay: pageSize inválido",
);
const replaySeen = new Set();
let convergedPass = null;
for (const replayPass of mutationReplay.passes) {
  const passIdentities = replayPass.pages.flat();
  assert(
    replayPass.pages.slice(0, -1).every((page) => page.length === mutationReplay.pageSize),
    `replay pasada ${replayPass.pass}: página intermedia incompleta`,
  );
  assert(
    replayPass.pages.at(-1).length <= mutationReplay.pageSize,
    `replay pasada ${replayPass.pass}: última página excede pageSize`,
  );
  const actualNew = [];
  for (const identity of passIdentities) {
    if (!replaySeen.has(identity)) actualNew.push(identity);
    replaySeen.add(identity);
  }
  assert(
    sameArray(actualNew, replayPass.expectedNewIdentities),
    `replay pasada ${replayPass.pass}: IDs nuevos incoherentes`,
  );
  if (actualNew.length === 0 && convergedPass === null) convergedPass = replayPass.pass;
}
const firstPassIdentities = new Set(mutationReplay.passes[0].pages.flat());
const singlePassMisses = mutationReplay.expectedFinalIdentities.filter(
  (identity) => !firstPassIdentities.has(identity),
);
assert(
  sameArray(singlePassMisses, mutationReplay.singlePassWouldMiss),
  "replay: omisión de pasada única no demostrada",
);
assert(
  mutationReplay.singlePassWouldMiss.includes(mutationReplay.mutation.identity),
  "replay: inserción no es la omisión demostrada",
);
assert(
  sameArray([...replaySeen].sort(), [...mutationReplay.expectedFinalIdentities].sort()),
  "replay: unión convergente incompleta",
);
assert(
  convergedPass === mutationReplay.expectedConvergedAfterPass,
  "replay: punto de convergencia inválido",
);
assert(
  mutationReplay.passes.at(-1).expectedNewIdentities.length === 0,
  "replay: no termina con pasada sin IDs nuevos",
);

const allUuids = [...files.values()].flatMap(uuids);
assert(allUuids.length > 0, "fixtures: faltan UUIDs RFC4122");
for (const uuid of allUuids) {
  assert(
    /^00000000-0000-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9]{12}$/.test(uuid),
    `UUID no sintético/canónico: ${uuid}`,
  );
}
assert(
  unique(uuids(page1)) && unique(uuids(page2)),
  "páginas: UUIDs duplicados dentro de una página",
);
assert(
  uuids(page1).every((uuid) => !uuids(page2).includes(uuid)),
  "páginas: UUIDs solapados",
);
assert(
  page2.includes(`data-uuid="${expected.syntheticUuid.document}"`),
  "page2/request detalle: UUID no enlazado",
);

const pdf = JSON.parse(files.get("pdf-response-headers.json"));
assert(
  pdf.origin === "captured-metadata" && pdf.status === 200,
  "evidencia PDF: origen/status inválido",
);
assert(
  pdf.headers["content-type"] === "application/octet-stream",
  "evidencia PDF: content-type inesperado",
);
assert(
  /^attachment;filename=Resolucion_FIXTURE\.pdf$/.test(pdf.headers["content-disposition"]),
  "evidencia PDF: filename no anonimizado",
);
assert(
  Number.isInteger(pdf.bodyEvidence.bytes) && pdf.bodyEvidence.bytes > 5,
  "evidencia PDF: tamaño inválido",
);
assert(pdf.bodyEvidence.magic === expected.download.magic, "evidencia PDF: magic inválido");
assert(/^\d+\.\d+$/.test(pdf.bodyEvidence.pdfVersion), "evidencia PDF: versión inválida");
assert(/^[0-9a-f]{64}$/.test(pdf.bodyEvidence.sha256), "evidencia PDF: SHA-256 inválido");
assert(
  pdf.classification === expected.download.classification && pdf.worksWithoutSession === true,
  "evidencia PDF: clasificación inválida",
);

for (const xmlPath of [
  "partial-page-2.xml",
  "detail-partial.xml",
  "detail-superior-partial.xml",
  "partial-redirect.xml",
  "partial-error.xml",
]) {
  try {
    execFileSync("xmllint", ["--noout", join(fixtureRoot, xmlPath)], { stdio: "pipe" });
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.warn("xmllint no disponible; se aplicaron comprobaciones estructurales internas.");
      break;
    }
    throw new Error(`${xmlPath} no es XML válido: ${error.message}`);
  }
}

try {
  execFileSync(
    process.execPath,
    [
      "--test",
      join(root, "test", "corpus-reconciler.test.mjs"),
      join(root, "test", "corpus-finalizer.test.mjs"),
    ],
    { stdio: "pipe" },
  );
} catch (error) {
  throw new Error(
    `Fase 0.1 reconciliación/finalización: pruebas fallaron\n${error.stdout?.toString() ?? ""}${error.stderr?.toString() ?? ""}`,
  );
}

console.log(
  `Fases 0/0.1 fixtures OK: ${manifestPaths.length} archivos; contrato HTTP, recibo FAIL estricto y replay convergente validados sin red.`,
);
