import { z } from "zod";

const uuid = z.uuid().transform((value) => value.toLowerCase());

export const corpusIdentitySchema = z
  .object({
    documentUuid: uuid.optional(),
    pdfUuid: uuid.optional(),
  })
  .refine((value) => value.documentUuid !== undefined || value.pdfUuid !== undefined, {
    message: "La membresía requiere identidad de documento o PDF",
  });

export const corpusMembershipSchema = z.object({
  schemaVersion: z.literal(1),
  type: z.literal("membership"),
  partitionId: z.string().min(1),
  pass: z.number().int().positive(),
  membershipToken: uuid,
  identity: corpusIdentitySchema,
  observedAt: z.iso.datetime(),
});

export type CorpusIdentity = z.infer<typeof corpusIdentitySchema>;
export type CorpusMembership = z.infer<typeof corpusMembershipSchema>;
