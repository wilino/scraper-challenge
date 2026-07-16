# Scraper de jurisprudencia del PJ

Scraper HTTP para enumerar resoluciones públicas del Poder Judicial del Perú y descargar los PDF
anunciados. Mantiene estado local reanudable, deduplica documentos y conserva un historial
append-only de descargas y fallos. No automatiza un navegador ni elude controles de acceso.

## Requisitos e instalación

- Node.js 22 o posterior y npm.
- Conectividad HTTPS hacia `jurisprudencia.pj.gob.pe`. Las validaciones vivas se ejecutan
  directamente desde Perú; este entorno no requiere VPN.

```bash
npm ci
npm run check
```

La aplicación no carga archivos `.env` automáticamente. Exporte las variables necesarias o
páselas en la invocación; [`.env.example`](.env.example) contiene valores de referencia.

## Flujo recomendado

`discover` recorre formularios y postbacks JSF, guarda documentos y prepara el manifest;
`retry-details` recupera detalles pendientes; `download` obtiene y valida PDF; `retry-failed`
reintenta descargas fallidas que ya son elegibles.

Canary pequeña en un directorio nuevo:

```bash
OUTPUT_DIR=./output/canary npm run scrape -- discover --partition supreme --limit 11 --max-pages 2
OUTPUT_DIR=./output/canary npm run scrape -- retry-details --limit 11
OUTPUT_DIR=./output/canary npm run scrape -- download --limit 1
OUTPUT_DIR=./output/canary npm run scrape -- retry-failed --limit 1
```

Una ejecución con `--partition`, `--limit` o `--max-pages` es deliberadamente parcial: sirve para
diagnóstico, pero nunca demuestra que el corpus global esté completo. Para un recorrido global,
omita esos límites:

```bash
npm run scrape -- discover --pass 1
npm run scrape -- retry-details
npm run scrape -- download
npm run scrape -- retry-failed
```

Interrumpa `discover` con `Ctrl-C` y continúe un checkpoint compatible con `--resume`. No mezcle
archivos de corridas, commits o conjuntos de particiones distintos en un mismo `OUTPUT_DIR`.

## Operación segura

El cliente conserva cookies y `ViewState` de la sesión JSF, usa ritmo serial y aplica reintentos
con backoff. Ante HTTP 429 comparte un cooldown global y respeta `Retry-After`; mantenga demoras
conservadoras y no reinicie para evadir la espera.

Los datos se escriben bajo `OUTPUT_DIR`: `data/documents.jsonl`, membresías, manifest y fallos;
`state/checkpoint.json`; `corpus-plan.json`; y PDF validados en `pdf/`. Son artefactos locales y no
deben publicarse.

En una operación exitosa, `stdout` contiene un único resumen JSON; logs y errores van a `stderr`.
Esto permite conservarlos por separado:

```bash
npm run --silent scrape -- discover --partition supreme --limit 1 >summary.json 2>run.log
node -e 'JSON.parse(require("node:fs").readFileSync("summary.json", "utf8"))'
```

`--silent` suprime el encabezado que npm añade a `stdout`; no silencia los logs de la aplicación.

`stopReason=natural_end` no implica completitud. Solo una reconciliación completa, sin límites ni
fallos de detalle abiertos, puede producir un recibo `PASS` mediante
`npm run reconcile:corpus -- --output-dir ./output --require-pass`.

## Desarrollo

```bash
npm run check
npm run test:coverage
npm run build
```

Consulte [USAGE.txt](USAGE.txt) para variables, archivos, códigos de salida, ayuda de comandos y el
procedimiento de reconciliación.
