import type { CheerioAPI } from "cheerio";

import { httpRequestSpecSchema, type HttpRequestSpec } from "../../models/index.js";
import { clean } from "./parser-normalization.js";
import { PjStructuralError } from "./parser-types.js";

type CheerioSelection = ReturnType<CheerioAPI>;

function strictDownloadRequest(href: string, baseUrl: string): HttpRequestSpec {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new PjStructuralError("Descriptor de descarga PJ contiene una URL inválida");
  }
  const parsed = httpRequestSpecSchema.safeParse({ method: "GET", url: url.href });
  if (!parsed.success) {
    throw new PjStructuralError("Descriptor de descarga PJ no es un ServletDescarga seguro");
  }
  return parsed.data;
}

export function findPdf(root: CheerioSelection, baseUrl: string): HttpRequestSpec | undefined {
  const link = root
    .find('a[data-file-type="pdf"], a[href*="ServletDescarga"]')
    .filter((_index, element) => {
      const anchor = root.find(element);
      const type = anchor.attr("data-file-type")?.toLowerCase();
      const icon = anchor.find("img, input").attr("src")?.toLowerCase() ?? "";
      return type === "pdf" || clean(anchor.text()).toLowerCase() === "pdf" || icon.includes("pdf");
    })
    .first();
  const href = link.attr("href");
  return href === undefined ? undefined : strictDownloadRequest(href, baseUrl);
}

export function findWordUrl(root: CheerioSelection, baseUrl: string): string | undefined {
  const href = root
    .find('a[href*="ServletDescarga"]')
    .filter((_index, element) => {
      const anchor = root.find(element);
      const type = anchor.attr("data-file-type")?.toLowerCase();
      const icon = anchor.find("img, input").attr("src")?.toLowerCase() ?? "";
      return (
        type === "word" || clean(anchor.text()).toLowerCase() === "word" || icon.includes("word")
      );
    })
    .first()
    .attr("href");
  return href === undefined ? undefined : strictDownloadRequest(href, baseUrl).url;
}
