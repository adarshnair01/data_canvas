/** PDF export: one A4 page per dashboard, each holding the dashboard's composite image. */

import type { RasterImage } from "./composite";

export interface PdfPage {
  title: string;
  image: RasterImage;
}

/** A4 in PDF points. */
export const A4 = { long: 841.89, short: 595.28 };
export const PDF_MARGIN = 28;
const HEADER = 30;

export interface PagePlacement {
  orientation: "landscape" | "portrait";
  pageWidth: number;
  pageHeight: number;
  image: { x: number; y: number; w: number; h: number };
}

/** Pick the orientation that shows the image largest, then fit it below the page header. */
export function placeOnPage(imgW: number, imgH: number): PagePlacement {
  const fit = (pageWidth: number, pageHeight: number) => {
    const boxW = pageWidth - PDF_MARGIN * 2;
    const boxH = pageHeight - PDF_MARGIN * 2 - HEADER;
    const s = Math.min(boxW / Math.max(imgW, 1), boxH / Math.max(imgH, 1));
    const w = imgW * s;
    const h = imgH * s;
    return { s, image: { x: PDF_MARGIN + (boxW - w) / 2, y: PDF_MARGIN + HEADER, w, h } };
  };
  const land = fit(A4.long, A4.short);
  const port = fit(A4.short, A4.long);
  return land.s >= port.s
    ? { orientation: "landscape", pageWidth: A4.long, pageHeight: A4.short, image: land.image }
    : { orientation: "portrait", pageWidth: A4.short, pageHeight: A4.long, image: port.image };
}

export interface PdfMeta {
  title: string;
  /** Shown in each page header after the dashboard name, e.g. the export date. */
  subtitle?: string;
}

export async function buildPdf(pages: PdfPage[], meta: PdfMeta): Promise<Uint8Array> {
  if (!pages.length) throw new Error("Nothing to export");
  const { jsPDF } = await import("jspdf");
  const first = placeOnPage(pages[0].image.width, pages[0].image.height);
  const doc = new jsPDF({ orientation: first.orientation, unit: "pt", format: "a4", compress: true });
  doc.setProperties({ title: meta.title, creator: "DataCanvas Desktop" });

  pages.forEach((page, i) => {
    const p = i === 0 ? first : placeOnPage(page.image.width, page.image.height);
    if (i > 0) doc.addPage("a4", p.orientation);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(24, 24, 27);
    doc.text(page.title, PDF_MARGIN, PDF_MARGIN + 12);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(113, 113, 122);
    const right = [meta.subtitle, `${i + 1} / ${pages.length}`].filter(Boolean).join("  ·  ");
    doc.text(right, p.pageWidth - PDF_MARGIN, PDF_MARGIN + 12, { align: "right" });
    const { x, y, w, h } = p.image;
    doc.addImage(page.image.dataUrl, "PNG", x, y, w, h, undefined, "FAST");
  });

  return new Uint8Array(doc.output("arraybuffer"));
}
