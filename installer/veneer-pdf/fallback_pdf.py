#!/usr/bin/env python3
"""veneer-pdf fallback renderer.

Used only when no Chrome is available. It turns the assembled HTML into a set of
simple text blocks and writes a valid Letter-size PDF. It prefers fpdf2 when it
is installed; otherwise it uses a tiny, dependency-free PDF writer built on the
standard library alone, so the fallback can never itself fail to import.

This path aims for a clean, readable document — not pixel-perfect fidelity.
"""

import argparse
import html
import re
import sys
from html.parser import HTMLParser

# Veneer palette.
INK = (0x26, 0x22, 0x1C)
ACCENT = (0x8A, 0x6D, 0x47)
MUTED = (0x6F, 0x67, 0x5C)

PAGE_W, PAGE_H = 612.0, 792.0  # Letter in PostScript points.
MARGIN = 54.0


class BlockExtractor(HTMLParser):
    """Collapse HTML into an ordered list of (kind, text) blocks."""

    BLOCK_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "blockquote", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks = []
        self.kind = None
        self.buf = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("head", "style", "script", "title"):
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag in self.BLOCK_TAGS:
            self._flush()
            self.kind = tag
        elif tag in ("hr",):
            self._flush()
            self.blocks.append(("hr", ""))
        elif tag == "br":
            self.buf.append("\n")

    def handle_endtag(self, tag):
        if tag in ("head", "style", "script", "title"):
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag in self.BLOCK_TAGS:
            self._flush()

    def handle_data(self, data):
        if self.skip_depth or self.kind is None:
            # Text outside a known block is ignored to keep output tidy.
            return
        self.buf.append(data)

    def _flush(self):
        if self.kind is not None:
            text = "".join(self.buf)
            if self.kind != "pre":
                text = re.sub(r"\s+", " ", text).strip()
            else:
                text = text.strip("\n")
            if text:
                self.blocks.append((self.kind, text))
        self.kind = None
        self.buf = []

    def result(self):
        self._flush()
        return self.blocks


def _latin1(text):
    """The core PDF fonts (used by both fallback renderers) are Latin-1 only.

    Replace anything outside Latin-1 so neither renderer can crash on a smart
    quote, em dash, or emoji. Chrome is the primary path for full fidelity.
    """
    if text is None:
        return None
    return text.encode("latin-1", "replace").decode("latin-1")


def extract_blocks(source_html):
    parser = BlockExtractor()
    parser.feed(source_html)
    blocks = parser.result()
    if blocks:
        return blocks
    # No recognizable structure: fall back to plain unescaped text paragraphs.
    text = html.unescape(re.sub(r"<[^>]+>", "", source_html))
    return [("p", line.strip()) for line in text.splitlines() if line.strip()]


# --- fpdf2 renderer -------------------------------------------------------

def render_with_fpdf(blocks, out_path, title):
    from fpdf import FPDF  # noqa: WPS433 (optional dependency)

    pdf = FPDF(orientation="P", unit="pt", format="letter")
    pdf.set_auto_page_break(True, margin=MARGIN)
    pdf.set_margins(MARGIN, MARGIN, MARGIN)
    pdf.add_page()

    def line(text, size, style, color, gap_before, gap_after):
        if gap_before:
            pdf.ln(gap_before)
        pdf.set_font("Helvetica", style, size)
        pdf.set_text_color(*color)
        pdf.multi_cell(0, size * 1.35, text)
        if gap_after:
            pdf.ln(gap_after)

    if title:
        line(title, 22, "B", INK, 0, 10)

    for kind, text in blocks:
        if kind == "h1":
            line(text, 22, "B", INK, 6, 6)
        elif kind == "h2":
            line(text, 16, "B", INK, 10, 4)
        elif kind in ("h3", "h4", "h5", "h6"):
            line(text, 13, "B", INK, 8, 3)
        elif kind == "li":
            line(f"-  {text}", 11, "", INK, 0, 2)
        elif kind == "blockquote":
            line(text, 11, "I", MUTED, 4, 4)
        elif kind == "pre":
            pdf.set_font("Courier", "", 10)
            pdf.set_text_color(*MUTED)
            pdf.multi_cell(0, 13, text)
            pdf.ln(4)
        elif kind == "hr":
            pdf.ln(6)
            y = pdf.get_y()
            pdf.set_draw_color(*ACCENT)
            pdf.line(MARGIN, y, PAGE_W - MARGIN, y)
            pdf.ln(10)
        else:
            line(text, 11, "", INK, 0, 8)

    pdf.output(out_path)


# --- stdlib-only renderer -------------------------------------------------

def _wrap(text, max_chars):
    words = text.split()
    lines, current = [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= max_chars or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines or [""]


def _esc(text):
    return text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")


def render_with_stdlib(blocks, out_path, title):
    """Emit a minimal, valid PDF using Helvetica (a standard-14 font)."""
    styles = {
        "h1": ("Helvetica-Bold", 20, 26, 10),
        "h2": ("Helvetica-Bold", 15, 20, 8),
        "h3": ("Helvetica-Bold", 12, 16, 6),
        "h4": ("Helvetica-Bold", 12, 16, 6),
        "p": ("Helvetica", 11, 15, 8),
        "li": ("Helvetica", 11, 15, 3),
        "blockquote": ("Helvetica-Oblique", 11, 15, 6),
        "pre": ("Courier", 10, 13, 6),
    }

    items = []
    if title:
        items.append(("h1", title))
    items.extend(blocks)

    pages = []
    lines = []  # (font, size, leading, text, x)
    y = PAGE_H - MARGIN

    def new_page():
        nonlocal lines, y
        pages.append(lines)
        lines = []
        y = PAGE_H - MARGIN

    for kind, text in items:
        if kind == "hr":
            y -= 12
            if y < MARGIN:
                new_page()
            lines.append(("HR", y))
            y -= 12
            continue
        font, size, leading, gap = styles.get(kind, styles["p"])
        prefix = "-  " if kind == "li" else ""
        max_chars = int((PAGE_W - 2 * MARGIN) / (size * 0.5))
        for wrapped in _wrap(prefix + text, max_chars):
            if y - leading < MARGIN:
                new_page()
            y -= leading
            lines.append((font, size, y, wrapped))
        y -= gap
    new_page()

    # Assemble PDF objects.
    objects = []

    def add(obj):
        objects.append(obj)
        return len(objects)  # 1-based object number

    font_helv = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    font_bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
    font_obl = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>")
    font_cour = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>")
    font_ids = {
        "Helvetica": font_helv,
        "Helvetica-Bold": font_bold,
        "Helvetica-Oblique": font_obl,
        "Courier": font_cour,
    }

    page_ids = []
    content_ids = []
    for page_lines in pages:
        parts = ["BT"]
        current_font = None
        for entry in page_lines:
            if entry[0] == "HR":
                _, yy = entry
                parts.append("ET")
                parts.append(f"0.54 0.43 0.28 RG 1 w {MARGIN:.1f} {yy:.1f} m {PAGE_W - MARGIN:.1f} {yy:.1f} l S")
                parts.append("BT")
                current_font = None
                continue
            font, size, yy, text = entry
            if font != current_font:
                parts.append(f"/{font.replace('-', '')} {size:.1f} Tf")
                current_font = font
            else:
                parts.append(f"{size:.1f} TL")
            parts.append("0.149 0.133 0.109 rg")
            parts.append(f"1 0 0 1 {MARGIN:.1f} {yy:.1f} Tm ({_esc(text)}) Tj")
        parts.append("ET")
        stream = "\n".join(parts)
        content_id = add(f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream")
        content_ids.append(content_id)

    # Font resources reference by alias without the dash (matches Tf names).
    resource = "<< /Font << " + " ".join(
        f"/{name.replace('-', '')} {oid} 0 R" for name, oid in font_ids.items()
    ) + " >> >>"

    pages_id = len(objects) + len(pages) + 1  # placeholder; fixed below
    for content_id in content_ids:
        page_id = add(
            f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W:.0f} {PAGE_H:.0f}] "
            f"/Resources {resource} /Contents {content_id} 0 R >>"
        )
        page_ids.append(page_id)

    kids = " ".join(f"{pid} 0 R" for pid in page_ids)
    real_pages_id = add(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_ids)} >>")
    # Repoint page /Parent references to the real Pages object.
    for pid in page_ids:
        objects[pid - 1] = objects[pid - 1].replace(f"/Parent {pages_id} 0 R", f"/Parent {real_pages_id} 0 R")
    catalog_id = add(f"<< /Type /Catalog /Pages {real_pages_id} 0 R >>")

    # Serialize with a cross-reference table.
    out = bytearray()
    out += b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    offsets = [0]
    for i, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n{obj}\nendobj\n".encode("latin-1")
    xref_pos = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode("latin-1")
    out += b"0000000000 65535 f \n"
    for off in offsets[1:]:
        out += f"{off:010d} 00000 n \n".encode("latin-1")
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R >>\n"
        f"startxref\n{xref_pos}\n%%EOF\n"
    ).encode("latin-1")

    with open(out_path, "wb") as handle:
        handle.write(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True, help="path to the assembled HTML file")
    ap.add_argument("-o", "--output", required=True, help="output PDF path")
    ap.add_argument("--title", default=None)
    args = ap.parse_args()

    with open(args.html, "r", encoding="utf-8") as handle:
        source_html = handle.read()
    blocks = [(kind, _latin1(text)) for kind, text in extract_blocks(source_html)]
    title = _latin1(args.title)

    try:
        render_with_fpdf(blocks, args.output, title)
        sys.stderr.write("fallback_pdf: used fpdf2\n")
    except ImportError:
        render_with_stdlib(blocks, args.output, title)
        sys.stderr.write("fallback_pdf: used stdlib writer\n")


if __name__ == "__main__":
    main()
