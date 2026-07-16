import { z } from "zod";

import { scrapedDocumentSchema } from "./document.js";

export const parsedPageSchema = z.object({
  currentPage: z.number().int().positive(),
  maxPages: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  queryTotal: z.number().int().nonnegative(),
  publishedGlobalTotal: z.number().int().nonnegative().nullable(),
  documents: z.array(scrapedDocumentSchema),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  endSignal: z.enum(["more", "natural_end"]),
});

export type ParsedPage = z.infer<typeof parsedPageSchema>;
