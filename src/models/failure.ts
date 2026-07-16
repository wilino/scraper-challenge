import { z } from "zod";

import { httpRequestSpecSchema } from "./http-request.js";

export const failurePhaseSchema = z.enum(["preflight", "discover", "detail", "download"]);
export const failureClassificationSchema = z.enum([
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

export const scrapeFailureSchema = z.object({
  schemaVersion: z.literal(1),
  failureId: z.uuid(),
  phase: failurePhaseSchema,
  partitionId: z.string().min(1).optional(),
  documentId: z.uuid().optional(),
  request: httpRequestSpecSchema.optional(),
  page: z.number().int().positive().optional(),
  classification: failureClassificationSchema,
  attempts: z.number().int().positive(),
  retryable: z.boolean(),
  message: z.string().min(1),
  status: z.number().int().min(100).max(599).optional(),
  code: z.string().min(1).optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  nextRetryAt: z.iso.datetime().optional(),
  resolution: z.enum(["open", "resolved", "abandoned"]),
  occurredAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().optional(),
});

export type ScrapeFailure = z.infer<typeof scrapeFailureSchema>;
