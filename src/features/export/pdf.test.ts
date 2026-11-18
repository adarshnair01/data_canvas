import { beforeEach, describe, expect, it, vi } from "vitest";

const docs: FakeDoc[] = [];

class FakeDoc {
  calls: { op: string; args: unknown[] }[] = [];
  constructor(public opts: unknown) {
    docs.push(this);
  }
  private rec = (op: string) => (...args: unknown[]) => {
    this.calls.push({ op, args });
    return this;
  };
  setProperties = this.rec("setProperties");
  addPage = this.rec("addPage");
  setFont = this.rec("setFont");
  setFontSize = this.rec("setFontSize");
  setTextColor = this.rec("setTextColor");
  text = this.rec("text");
  addImage = this.rec("addImage");
  output = (type: string) => {
    this.calls.push({ op: "output", args: [type] });
    return new Uint8Array([37, 80, 68, 70]).buffer;
  };
}

vi.mock("jspdf", () => ({ jsPDF: FakeDoc }));

const { A4, PDF_MARGIN, buildPdf, placeOnPage } = await import("./pdf");

const img = (width: number, height: number) => ({ dataUrl: `data:image/png;base64,${width}x${height}`, width, height });

describe("placeOnPage", () => {
  it("uses landscape for wide dashboards and portrait for tall ones", () => {
    expect(placeOnPage(2560, 1200).orientation).toBe("landscape");
    expect(placeOnPage(2560, 6000).orientation).toBe("portrait");
  });

  it("keeps the aspect ratio inside the margins", () => {
    for (const [w, h] of [
      [2560, 1200],
      [2560, 6000],
      [100, 100],
    ]) {
      const p = placeOnPage(w, h);
      expect(p.image.w / p.image.h).toBeCloseTo(w / h, 5);
      expect(p.image.x).toBeGreaterThanOrEqual(PDF_MARGIN - 1e-9);
      expect(p.image.x + p.image.w).toBeLessThanOrEqual(p.pageWidth - PDF_MARGIN + 1e-9);
      expect(p.image.y + p.image.h).toBeLessThanOrEqual(p.pageHeight - PDF_MARGIN + 1e-9);
    }
    expect(placeOnPage(2560, 1200).pageWidth).toBe(A4.long);
  });
});

describe("buildPdf", () => {
  beforeEach(() => {
    docs.length = 0;
  });

  it("creates one page per dashboard with its title and image", async () => {
    const bytes = await buildPdf(
      [
        { title: "Overview", image: img(2560, 1400) },
        { title: "Detail", image: img(2560, 7000) },
        { title: "Regions", image: img(2560, 900) },
      ],
      { title: "Q3 Review", subtitle: "Nov 18, 2026" },
    );
    expect(Array.from(bytes)).toEqual([37, 80, 68, 70]);
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.opts).toMatchObject({ orientation: "landscape", unit: "pt", format: "a4" });

    const addPages = doc.calls.filter((c) => c.op === "addPage");
    expect(addPages.map((c) => c.args)).toEqual([
      ["a4", "portrait"],
      ["a4", "landscape"],
    ]);
    const images = doc.calls.filter((c) => c.op === "addImage");
    expect(images.map((c) => c.args[0])).toEqual([
      "data:image/png;base64,2560x1400",
      "data:image/png;base64,2560x7000",
      "data:image/png;base64,2560x900",
    ]);
    expect(images.every((c) => c.args[1] === "PNG")).toBe(true);
    const texts = doc.calls.filter((c) => c.op === "text").map((c) => c.args[0]);
    expect(texts).toEqual([
      "Overview",
      "Nov 18, 2026  ·  1 / 3",
      "Detail",
      "Nov 18, 2026  ·  2 / 3",
      "Regions",
      "Nov 18, 2026  ·  3 / 3",
    ]);
    expect(doc.calls.at(-1)).toEqual({ op: "output", args: ["arraybuffer"] });
  });

  it("refuses to build an empty PDF", async () => {
    await expect(buildPdf([], { title: "x" })).rejects.toThrow(/Nothing to export/);
  });
});
