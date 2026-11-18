#!/usr/bin/env python3
"""Regenerate the committed import fixtures (stdlib only).

    python3 src-tauri/tests/fixtures/generate.py

The ~1M-row CSV is not committed; `import::fixture_tests` generates it in a temp dir.
"""

import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent

SALES = [["order_date", "region", "product", "units", "revenue"]] + [
    [45292 + i * 7, ["North", "South", "East", "West"][i % 4], ["Widgets", "Gadgets", "Gizmos"][i % 3], 1 + i, round((1 + i) * 12.5, 2)]
    for i in range(12)
]
TARGETS = [
    ["region", "target", "met"],
    ["North", 1500, True],
    ["South", 1200, False],
    ["East", 900.5, True],
    ["West", 1100, False],
]
SHEETS = [("Sales", SALES, {0}), ("Targets", TARGETS, set()), ("Notes", [], set())]


def col(i: int) -> str:
    return chr(ord("A") + i)


def sheet_xml(rows, date_cols, strings):
    out = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, v in enumerate(row):
            ref = f"{col(c)}{r}"
            if isinstance(v, bool):
                cells.append(f'<c r="{ref}" t="b"><v>{int(v)}</v></c>')
            elif isinstance(v, (int, float)):
                style = ' s="1"' if c in date_cols and r > 1 else ""
                cells.append(f'<c r="{ref}"{style}><v>{v}</v></c>')
            else:
                if v not in strings:
                    strings.append(v)
                cells.append(f'<c r="{ref}" t="s"><v>{strings.index(v)}</v></c>')
        out.append(f'<row r="{r}">{"".join(cells)}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'<sheetData>{"".join(out)}</sheetData></worksheet>'
    )


def write_xlsx(path: Path):
    strings: list[str] = []
    sheets = [sheet_xml(rows, dates, strings) for _, rows, dates in SHEETS]
    n = len(SHEETS)
    ct = "".join(
        f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for i in range(1, n + 1)
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
            f"{ct}</Types>",
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>",
        )
        entries = "".join(f'<sheet name="{name}" sheetId="{i}" r:id="rId{i}"/>' for i, (name, _, _) in enumerate(SHEETS, 1))
        z.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{entries}</sheets></workbook>",
        )
        rels = "".join(
            f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, n + 1)
        )
        z.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{rels}"
            '<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            '<Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
            "</Relationships>",
        )
        z.writestr(
            "xl/styles.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
        )
        sst = "".join(f"<si><t>{escape(s)}</t></si>" for s in strings)
        z.writestr(
            "xl/sharedStrings.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(strings)}" uniqueCount="{len(strings)}">{sst}</sst>',
        )
        for i, xml in enumerate(sheets, 1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", xml)


def main():
    xlsx = HERE / "multi_sheet.xlsx"
    write_xlsx(xlsx)

    # Truncated archive: the zip central directory is missing, as after an interrupted copy.
    data = xlsx.read_bytes()
    (HERE / "malformed.xlsx").write_bytes(data[: len(data) // 2])

    # 40 good rows, one row with extra fields, 9 more good rows.
    lines = ["id,name,amount"]
    lines += [f"{i},Item {i},{i * 1.5}" for i in range(1, 41)]
    lines.append("41,Broken row,1,extra,fields")
    lines += [f"{i},Item {i},{i * 1.5}" for i in range(42, 51)]
    (HERE / "malformed.csv").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
