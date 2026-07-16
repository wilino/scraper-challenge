import { z } from "zod";

export const checkpointSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("pj"),
  baseUrl: z.url(),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/),
  partitionId: z.string().min(1),
  page: z.number().int().positive(),
  confirmedRow: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;
