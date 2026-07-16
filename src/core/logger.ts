import pino, { type DestinationStream, type LevelWithSilent, type Logger } from "pino";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /^(?:cookie|cookies|setcookie|authorization|proxyauthorization|credential|credentials|password|passwd|token|accesstoken|refreshtoken|idtoken|viewstate|javaxfacesviewstate)$/i;

function normalizedKey(key: string): string {
  return key.replaceAll(/[^a-z0-9]/gi, "");
}

function redactString(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/([?&](?:access_?token|token|javax\.faces\.ViewState)=)[^&\s]+/gi, `$1${REDACTED}`);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  if (value instanceof Date) return value.toISOString();
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(normalizedKey(key)) ? REDACTED : redactValue(item, seen),
    ]),
  );
}

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

export type LoggerContext = Readonly<Record<string, unknown>>;

export interface CreateLoggerOptions {
  runId: string;
  level?: LevelWithSilent;
  context?: LoggerContext;
  destination?: DestinationStream;
}

export function createLogger({
  runId,
  level = "info",
  context = {},
  destination,
}: CreateLoggerOptions): Logger {
  const options = {
    level,
    base: { runId, ...(redactSensitive(context) as Record<string, unknown>) },
    hooks: {
      logMethod(inputArguments: unknown[], method: (...arguments_: unknown[]) => void) {
        method.apply(
          this,
          inputArguments.map((argument) => redactSensitive(argument)),
        );
      },
    },
  };
  return pino(options, destination ?? pino.destination({ dest: 2, sync: true }));
}
