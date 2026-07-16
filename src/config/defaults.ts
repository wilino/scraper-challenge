export const PJ_ORIGIN = "https://jurisprudencia.pj.gob.pe";

export const DEFAULT_ENV = {
  SCRAPER_BASE_URL: PJ_ORIGIN,
  SCRAPER_START_PATH: "/jurisprudenciaweb/faces/page/inicio.xhtml",
  SCRAPER_RESULTS_PATH: "/jurisprudenciaweb/faces/page/resultado.xhtml",
  OUTPUT_DIR: "./output",
  CONNECT_TIMEOUT_MS: 15000,
  REQUEST_TIMEOUT_MS: 120000,
  PDF_TIMEOUT_MS: 120000,
  MIN_REQUEST_DELAY_MS: 1500,
  MAX_REQUEST_DELAY_MS: 3500,
  MAX_RETRIES: 5,
  BACKOFF_BASE_MS: 2000,
  BACKOFF_MAX_MS: 120000,
  GLOBAL_COOLDOWN_AFTER_429_MS: 30000,
  MAX_PDF_BYTES: 104857600,
  MAX_HTML_BYTES: 5242880,
  HTML_CONCURRENCY: 1,
  PDF_CONCURRENCY: 1,
  USER_AGENT: "jurisprudencia-scraper/1.0",
  LOG_LEVEL: "info",
} as const;

export const ALLOWED_SCRAPER_ORIGINS = new Set<string>([PJ_ORIGIN]);
