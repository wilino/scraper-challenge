import { z } from "zod";

import { httpRequestSpecSchema } from "./http-request.js";

const base = z.object({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  documentId: z.uuid(),
  occurredAt: z.iso.datetime(),
});

export const downloadManifestEventSchema = z.discriminatedUnion("state", [
  base.extend({ state: z.literal("pending"), request: httpRequestSpecSchema }),
  base.extend({
    state: z.literal("downloaded"),
    request: httpRequestSpecSchema,
    relativePath: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
    effectiveUrl: z.url(),
  }),
  base.extend({ state: z.literal("failed"), request: httpRequestSpecSchema, failureId: z.uuid() }),
  base.extend({
    state: z.literal("no_pdf"),
    reason: z.enum(["not_advertised", "word_only"]),
  }),
]);

export type DownloadManifestEvent = z.infer<typeof downloadManifestEventSchema>;
