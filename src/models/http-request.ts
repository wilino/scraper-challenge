import { z } from "zod";

import { PJ_ORIGIN } from "../config/defaults.js";

const PJ_PDF_PATH = "/jurisprudenciaweb/ServletDescarga";

export const orderedPairsSchema = z.array(z.tuple([z.string(), z.string()]));

export const httpRequestSpecSchema = z
  .object({
    method: z.literal("GET"),
    url: z.url(),
  })
  .strict()
  .superRefine(({ url }, context) => {
    const parsed = new URL(url);
    const uuidValues = parsed.searchParams.getAll("uuid");
    if (
      parsed.origin !== PJ_ORIGIN ||
      parsed.pathname !== PJ_PDF_PATH ||
      [...parsed.searchParams.keys()].some((key) => key !== "uuid") ||
      uuidValues.length !== 1 ||
      !z.uuid().safeParse(uuidValues[0]).success ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "debe ser un GET PJ seguro a ServletDescarga con un único UUID",
      });
    }
  });

export type HttpRequestSpec = z.infer<typeof httpRequestSpecSchema>;
export type OrderedPairs = z.infer<typeof orderedPairsSchema>;
