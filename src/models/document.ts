import { z } from "zod";

import { httpRequestSpecSchema } from "./http-request.js";

const metadataValuesSchema = z.record(z.string(), z.array(z.string()));

export const documentMetadataSchema = z.object({
  list: metadataValuesSchema,
  detail: metadataValuesSchema,
  unknownFields: metadataValuesSchema.default({}),
});

export const pdfDiscoveryStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), request: httpRequestSpecSchema }),
  z.object({ state: z.literal("no_pdf"), reason: z.enum(["not_advertised", "word_only"]) }),
]);

export const scrapedDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: z.uuid(),
  partitionId: z.string().min(1),
  sourcePage: z.number().int().positive(),
  sourceRow: z.number().int().nonnegative(),
  discoveredAt: z.iso.datetime(),
  title: z.string().min(1).optional(),
  resolutionNumber: z.string().min(1).optional(),
  caseNumber: z.string().min(1).optional(),
  resolutionDate: z.string().min(1).optional(),
  metadata: documentMetadataSchema,
  wordUrl: z.url().optional(),
  pdf: pdfDiscoveryStateSchema,
});

export type ScrapedDocument = z.infer<typeof scrapedDocumentSchema>;
