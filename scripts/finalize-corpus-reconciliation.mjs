#!/usr/bin/env node

import path from "node:path";
import { finalizeCorpus, writeReceiptAtomic } from "./lib/corpus-finalizer.mjs";

const usage = `Uso: node scripts/finalize-corpus-reconciliation.mjs [opciones]

  --output-dir <ruta>       OUTPUT_DIR de la corrida (o variable OUTPUT_DIR)
  --metadata <ruta>         metadatos de corrida; por defecto run-receipt.json
  --supervisor-log <ruta>   log de convergencia; por defecto supervisor.log
  --discovery-log <ruta>    salidas JSON de discover; por defecto discover.log
  --receipt <ruta|->        salida; por defecto corpus-reconciliation-receipt.json
  --require-pass            termina con 2 si el recibo queda en FAIL`;

const values = new Map();
let requirePass = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const option = process.argv[index];
  if (option === "--require-pass") {
    requirePass = true;
    continue;
  }
  if (option === "--help" || option === "-h") {
    console.log(usage);
    process.exit(0);
  }
  if (
    !["--output-dir", "--metadata", "--supervisor-log", "--discovery-log", "--receipt"].includes(
      option,
    )
  )
    throw new Error(`Opción desconocida: ${option}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${option} requiere un valor`);
  values.set(option, value);
  index += 1;
}

const outputDir = values.get("--output-dir") ?? process.env.OUTPUT_DIR;
if (!outputDir) throw new Error("Falta --output-dir o la variable OUTPUT_DIR");
const receiptPath =
  values.get("--receipt") ?? path.join(outputDir, "corpus-reconciliation-receipt.json");

try {
  const receipt = await finalizeCorpus({
    outputDir,
    metadataPath: values.get("--metadata"),
    supervisorLogPath: values.get("--supervisor-log"),
    discoveryLogPath: values.get("--discovery-log"),
  });
  if (receiptPath === "-") process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  else await writeReceiptAtomic(receiptPath, receipt);
  if (requirePass && receipt.status !== "PASS") process.exitCode = 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
