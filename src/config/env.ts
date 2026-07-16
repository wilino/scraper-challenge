import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

import { ALLOWED_SCRAPER_ORIGINS, DEFAULT_ENV } from "./defaults.js";

const positiveInteger = z.coerce.number().int().positive();
const logLevel = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const schema = z
  .object({
    SCRAPER_BASE_URL: z.url().default(DEFAULT_ENV.SCRAPER_BASE_URL),
    SCRAPER_START_PATH: z.string().startsWith("/").default(DEFAULT_ENV.SCRAPER_START_PATH),
    SCRAPER_RESULTS_PATH: z.string().startsWith("/").default(DEFAULT_ENV.SCRAPER_RESULTS_PATH),
    OUTPUT_DIR: z.string().min(1).default(DEFAULT_ENV.OUTPUT_DIR),
    CONNECT_TIMEOUT_MS: positiveInteger.default(DEFAULT_ENV.CONNECT_TIMEOUT_MS),
    REQUEST_TIMEOUT_MS: positiveInteger.default(DEFAULT_ENV.REQUEST_TIMEOUT_MS),
    PDF_TIMEOUT_MS: positiveInteger.default(DEFAULT_ENV.PDF_TIMEOUT_MS),
    MIN_REQUEST_DELAY_MS: positiveInteger.default(DEFAULT_ENV.MIN_REQUEST_DELAY_MS),
    MAX_REQUEST_DELAY_MS: positiveInteger.default(DEFAULT_ENV.MAX_REQUEST_DELAY_MS),
    MAX_RETRIES: z.coerce.number().int().nonnegative().default(DEFAULT_ENV.MAX_RETRIES),
    BACKOFF_BASE_MS: positiveInteger.default(DEFAULT_ENV.BACKOFF_BASE_MS),
    BACKOFF_MAX_MS: positiveInteger.default(DEFAULT_ENV.BACKOFF_MAX_MS),
    GLOBAL_COOLDOWN_AFTER_429_MS: positiveInteger.default(DEFAULT_ENV.GLOBAL_COOLDOWN_AFTER_429_MS),
    MAX_PAGES: positiveInteger.default(DEFAULT_ENV.MAX_PAGES),
    MAX_DOCUMENTS: positiveInteger.default(DEFAULT_ENV.MAX_DOCUMENTS),
    MAX_PDF_BYTES: positiveInteger.default(DEFAULT_ENV.MAX_PDF_BYTES),
    MAX_HTML_BYTES: positiveInteger.default(DEFAULT_ENV.MAX_HTML_BYTES),
    HTML_CONCURRENCY: positiveInteger.default(DEFAULT_ENV.HTML_CONCURRENCY),
    PDF_CONCURRENCY: positiveInteger.default(DEFAULT_ENV.PDF_CONCURRENCY),
    USER_AGENT: z.string().min(1).default(DEFAULT_ENV.USER_AGENT),
    LOG_LEVEL: logLevel.default(DEFAULT_ENV.LOG_LEVEL),
  })
  .superRefine((environment, context) => {
    const baseUrl = new URL(environment.SCRAPER_BASE_URL);
    if (baseUrl.protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["SCRAPER_BASE_URL"], message: "debe usar HTTPS" });
    }
    if (!ALLOWED_SCRAPER_ORIGINS.has(baseUrl.origin)) {
      context.addIssue({
        code: "custom",
        path: ["SCRAPER_BASE_URL"],
        message: `origen no permitido: ${baseUrl.origin}`,
      });
    }
    if (environment.MIN_REQUEST_DELAY_MS > environment.MAX_REQUEST_DELAY_MS) {
      context.addIssue({
        code: "custom",
        path: ["MIN_REQUEST_DELAY_MS"],
        message: "debe ser menor o igual que MAX_REQUEST_DELAY_MS",
      });
    }
    const startUrl = new URL(environment.SCRAPER_START_PATH, baseUrl);
    const resultsUrl = new URL(environment.SCRAPER_RESULTS_PATH, baseUrl);
    if (
      startUrl.pathname === resultsUrl.pathname ||
      startUrl.pathname.endsWith("/resultado.xhtml")
    ) {
      context.addIssue({
        code: "custom",
        path: ["SCRAPER_START_PATH"],
        message: "resultado.xhtml no es un bootstrap válido; use inicio.xhtml",
      });
    }
  });

export interface ScraperConfig {
  baseUrl: string;
  startPath: string;
  resultsPath: string;
  outputDir: string;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  pdfTimeoutMs: number;
  minRequestDelayMs: number;
  maxRequestDelayMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  globalCooldownAfter429Ms: number;
  maxPages: number;
  maxDocuments: number;
  maxPdfBytes: number;
  maxHtmlBytes: number;
  htmlConcurrency: number;
  pdfConcurrency: number;
  userAgent: string;
  logLevel: z.infer<typeof logLevel>;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function prepareOutputDirectory(configuredPath: string, cwd: string): string {
  const outputDir = path.resolve(cwd, configuredPath);
  try {
    mkdirSync(outputDir, { recursive: true });
    if (!statSync(outputDir).isDirectory()) throw new Error("la ruta no es un directorio");
    accessSync(outputDir, constants.W_OK);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "error desconocido";
    throw new ConfigurationError(
      `OUTPUT_DIR no se puede crear o escribir (${outputDir}): ${reason}`,
    );
  }
  return outputDir;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "configuración"}: ${issue.message}`)
    .join("; ");
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ScraperConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(`Configuración inválida: ${formatIssues(parsed.error)}`);
  }
  const value = parsed.data;
  return {
    baseUrl: new URL(value.SCRAPER_BASE_URL).origin,
    startPath: value.SCRAPER_START_PATH,
    resultsPath: value.SCRAPER_RESULTS_PATH,
    outputDir: prepareOutputDirectory(value.OUTPUT_DIR, cwd),
    connectTimeoutMs: value.CONNECT_TIMEOUT_MS,
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
    pdfTimeoutMs: value.PDF_TIMEOUT_MS,
    minRequestDelayMs: value.MIN_REQUEST_DELAY_MS,
    maxRequestDelayMs: value.MAX_REQUEST_DELAY_MS,
    maxRetries: value.MAX_RETRIES,
    backoffBaseMs: value.BACKOFF_BASE_MS,
    backoffMaxMs: value.BACKOFF_MAX_MS,
    globalCooldownAfter429Ms: value.GLOBAL_COOLDOWN_AFTER_429_MS,
    maxPages: value.MAX_PAGES,
    maxDocuments: value.MAX_DOCUMENTS,
    maxPdfBytes: value.MAX_PDF_BYTES,
    maxHtmlBytes: value.MAX_HTML_BYTES,
    htmlConcurrency: value.HTML_CONCURRENCY,
    pdfConcurrency: value.PDF_CONCURRENCY,
    userAgent: value.USER_AGENT,
    logLevel: value.LOG_LEVEL,
  };
}
