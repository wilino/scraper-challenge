import { z } from "zod";

import { orderedPairsSchema } from "./http-request.js";

export const sessionStateSchema = z.object({
  formAction: z.url(),
  method: z.enum(["GET", "POST"]),
  formId: z.string().min(1).optional(),
  successfulControls: orderedPairsSchema,
  viewStateName: z.literal("javax.faces.ViewState"),
  viewStateValue: z.string().min(1),
  partitionId: z.string().min(1),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/),
  currentPage: z.number().int().positive(),
});

export type SessionState = z.infer<typeof sessionStateSchema>;
