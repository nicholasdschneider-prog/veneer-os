#!/usr/bin/env python3
"""Create safe, polished XLSX workbooks from CSV, TSV, or structured JSON."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET

SCRIPT_DIR = Path(__file__).resolve().parent
XLSXWRITER_WHEEL = "xlsxwriter-3.2.9-py3-none-any.whl"
sys.path.insert(0, str(SCRIPT_DIR / "vendor" / XLSXWRITER_WHEEL))

import xlsxwriter  # type: ignore  # vendored, pinned below

PINNED_XLSXWRITER_VERSION = "3.2.9"
MAX_INPUT_BYTES = 64 * 1024 * 1024
MAX_ROWS = 1_048_576
MAX_COLUMNS = 16_384
MAX_CELL_TEXT = 32_767
INVALID_SHEET_CHARS = re.compile(r"[\[\]:*?/\\]")
XML_CONTROLS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
FORMULA_PREFIXES = ("=", "+", "-", "@")

PRIMARY = "#26221c"
ACCENT = "#8a6d47"
PANEL = "#f0e7d8"
MUTED = "#6f675c"

FORMAT_PRESETS = {
    "header": {"bold": True, "font_color": PRIMARY, "bg_color": PANEL, "border": 1, "border_color": ACCENT, "text_wrap": True, "valign": "vcenter"},
    "currency": {"num_format": "$#,##0.00;[Red]-$#,##0.00"},
    "integer": {"num_format": "#,##0"},
    "decimal": {"num_format": "#,##0.00"},
    "percent": {"num_format": "0.0%"},
    "date": {"num_format": "yyyy-mm-dd"},
    "datetime": {"num_format": "yyyy-mm-dd hh:mm"},
    "text": {"num_format": "@"},
}

ALLOWED_FORMAT_KEYS = {
    "bold", "italic", "font_name", "font_size", "font_color", "bg_color", "border", "border_color",
    "align", "valign", "num_format", "text_wrap", "locked", "hidden", "underline", "font_strikeout",
    "indent", "shrink", "rotation",
}
ALLOWED_CHART_TYPES = {"area", "bar", "column", "doughnut", "line", "pie", "radar", "scatter", "stock"}


class InputError(ValueError):
    """An input error that is safe to show to the user."""


def clean_text(value: object) -> str:
    text = XML_CONTROLS.sub("\ufffd", str(value))
    if len(text) > MAX_CELL_TEXT:
        raise InputError(f"cell text is longer than Excel's {MAX_CELL_TEXT}-character limit")
    return text


def validate_sheet_name(name: object) -> str:
    value = clean_text(name).strip()
    if not value:
        raise InputError("sheet name cannot be empty")
    if len(value) > 31:
        raise InputError(f"sheet name is longer than 31 characters: {value}")
    if INVALID_SHEET_CHARS.search(value):
        raise InputError(f"sheet name has an invalid character: {value}")
    if value.startswith("'") or value.endswith("'"):
        raise InputError(f"sheet name cannot start or end with an apostrophe: {value}")
    return value


def default_sheet_name(value: str) -> str:
    name = INVALID_SHEET_CHARS.sub("-", value).strip(" '") or "Sheet1"
    return name[:31]


def parse_iso_date(value: str, include_time: bool = False) -> dt.date | dt.datetime:
    try:
        if include_time:
            normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
            parsed = dt.datetime.fromisoformat(normalized)
            # XLSX stores a timezone-free serial value. Normalize aware input
            # to UTC before removing its timezone so the instant is stable.
            return parsed.astimezone(dt.timezone.utc).replace(tzinfo=None) if parsed.tzinfo else parsed
        return dt.date.fromisoformat(value)
    except ValueError as exc:
        kind = "datetime" if include_time else "date"
        raise InputError(f"invalid ISO {kind}: {value}") from exc


def infer_delimited_value(value: str) -> object:
    """Infer safe CSV types. Formula-like prefixes always remain text."""
    text = clean_text(value)
    stripped = text.strip()
    if not stripped or stripped.startswith(FORMULA_PREFIXES):
        return text
    if stripped.lower() == "true":
        return True
    if stripped.lower() == "false":
        return False
    if re.fullmatch(r"(?:0|[1-9]\d*)", stripped):
        try:
            return int(stripped)
        except ValueError:
            return text
    if re.fullmatch(r"(?:0|[1-9]\d*)\.\d+", stripped):
        try:
            number = float(stripped)
            return number if math.isfinite(number) else text
        except ValueError:
            return text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", stripped):
        try:
            return dt.date.fromisoformat(stripped)
        except ValueError:
            return text
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?", stripped):
        try:
            normalized = stripped[:-1] + "+00:00" if stripped.endswith("Z") else stripped
            return dt.datetime.fromisoformat(normalized)
        except ValueError:
            return text
    return text


def parse_format(spec: object, label: str = "format") -> dict:
    if spec is None:
        return {}
    if isinstance(spec, str):
        if spec not in FORMAT_PRESETS:
            raise InputError(f"unknown {label} preset: {spec}")
        return dict(FORMAT_PRESETS[spec])
    if not isinstance(spec, dict):
        raise InputError(f"{label} must be a preset name or object")
    unknown = set(spec) - ALLOWED_FORMAT_KEYS
    if unknown:
        raise InputError(f"unsupported {label} option: {sorted(unknown)[0]}")
    result = dict(spec)
    for color_key in ("font_color", "bg_color", "border_color"):
        if color_key in result and not re.fullmatch(r"#?[0-9A-Fa-f]{6}", str(result[color_key])):
            raise InputError(f"{label}.{color_key} must be a six-digit color")
    return result


class FormatCache:
    def __init__(self, workbook: xlsxwriter.Workbook):
        self.workbook = workbook
        self.cache: dict[str, object] = {}

    def get(self, *specs: object):
        merged: dict = {}
        for spec in specs:
            merged.update(parse_format(spec))
        if not merged:
            return None
        key = json.dumps(merged, sort_keys=True, separators=(",", ":"))
        if key not in self.cache:
            self.cache[key] = self.workbook.add_format(merged)
        return self.cache[key]


def explicit_cell(cell: object) -> tuple[object, object, object | None]:
    """Return (kind, value, optional result) for a structured JSON cell."""
    if not isinstance(cell, dict):
        return "value", cell, None
    if "formula" in cell:
        formula = cell["formula"]
        if not isinstance(formula, str) or not formula.startswith("=") or len(formula) < 2:
            raise InputError("formula cells need a formula string that starts with =")
        return "formula", clean_text(formula), cell.get("result", 0)
    if "value" not in cell:
        raise InputError("cell objects need value or formula")
    kind = cell.get("type", "value")
    value = cell["value"]
    if kind == "date":
        return "date", parse_iso_date(str(value)), None
    if kind == "datetime":
        return "datetime", parse_iso_date(str(value), include_time=True), None
    if kind == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise InputError("number cells need a finite JSON number")
        return "value", value, None
    if kind == "boolean":
        if not isinstance(value, bool):
            raise InputError("boolean cells need true or false")
        return "value", value, None
    if kind in ("string", "value"):
        return "value", value, None
    raise InputError(f"unsupported cell type: {kind}")


def write_cell(worksheet, row: int, col: int, cell: object, formats: FormatCache, column_format: object = None):
    cell_format_spec = cell.get("format") if isinstance(cell, dict) else None
    fmt = formats.get(column_format, cell_format_spec)
    kind, value, result = explicit_cell(cell)
    if kind == "formula":
        worksheet.write_formula(row, col, value, fmt, result)
    elif value is None:
        worksheet.write_blank(row, col, None, fmt)
    elif isinstance(value, bool):
        worksheet.write_boolean(row, col, value, fmt)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value):
            raise InputError("numeric cells must be finite")
        worksheet.write_number(row, col, value, fmt)
    elif isinstance(value, dt.datetime):
        worksheet.write_datetime(row, col, value, formats.get("datetime", column_format, cell_format_spec))
    elif isinstance(value, dt.date):
        worksheet.write_datetime(row, col, value, formats.get("date", column_format, cell_format_spec))
    elif isinstance(value, (list, dict)):
        raise InputError("cell values must be strings, numbers, dates, booleans, null, or explicit formulas")
    else:
        # write_string is intentional: it cannot turn =, +, -, or @ into a formula.
        worksheet.write_string(row, col, clean_text(value), fmt)


def normalize_columns(sheet: dict, rows: list) -> tuple[list[dict], list[list], bool]:
    raw_columns = sheet.get("columns")
    object_rows = bool(rows and all(isinstance(row, dict) for row in rows))
    if rows and any(isinstance(row, dict) for row in rows) and not object_rows:
        raise InputError("a sheet cannot mix object rows and array rows")

    if raw_columns is not None:
        if not isinstance(raw_columns, list) or not raw_columns:
            raise InputError("columns must be a non-empty array")
        columns = []
        for index, item in enumerate(raw_columns):
            if isinstance(item, str):
                columns.append({"key": item, "header": item})
            elif isinstance(item, dict):
                key = item.get("key", item.get("header", str(index + 1)))
                columns.append({**item, "key": str(key), "header": clean_text(item.get("header", key))})
            else:
                raise InputError("each column must be a name or object")
    elif object_rows:
        keys: list[str] = []
        for row in rows:
            for key in row:
                if key not in keys:
                    keys.append(key)
        if not keys:
            raise InputError("object rows have no columns")
        columns = [{"key": str(key), "header": clean_text(key)} for key in keys]
    else:
        width = max((len(row) for row in rows if isinstance(row, list)), default=0)
        if width == 0:
            raise InputError("sheet has no columns")
        columns = [{"key": str(index), "header": f"Column {index + 1}"} for index in range(width)]

    if len(columns) > MAX_COLUMNS:
        raise InputError(f"sheet has more than Excel's {MAX_COLUMNS}-column limit")

    if object_rows:
        matrix = [[row.get(column["key"]) for column in columns] for row in rows]
        generated_header = True
    else:
        matrix = []
        for row in rows:
            if not isinstance(row, list):
                raise InputError("rows must be arrays or objects")
            matrix.append(list(row) + [None] * (len(columns) - len(row)))
        generated_header = raw_columns is not None
    return columns, matrix, generated_header


def range_option(value: object, label: str):
    if isinstance(value, str) and value.startswith("="):
        return value
    if isinstance(value, list) and len(value) == 5 and isinstance(value[0], str) and all(isinstance(v, int) for v in value[1:]):
        return value
    raise InputError(f"chart {label} must be an Excel range string that starts with = or [sheet,row,col,row,col]")


def add_charts(workbook, worksheet, charts: object):
    if charts is None:
        return
    if not isinstance(charts, list):
        raise InputError("charts must be an array")
    for spec in charts:
        if not isinstance(spec, dict):
            raise InputError("each chart must be an object")
        chart_type = spec.get("type")
        if chart_type not in ALLOWED_CHART_TYPES:
            raise InputError(f"unsupported chart type: {chart_type}")
        options = {"type": chart_type}
        if "subtype" in spec:
            options["subtype"] = clean_text(spec["subtype"])
        chart = workbook.add_chart(options)
        series = spec.get("series")
        if not isinstance(series, list) or not series:
            raise InputError("each chart needs at least one series")
        for item in series:
            if not isinstance(item, dict) or "values" not in item:
                raise InputError("chart series need values")
            series_options = {"values": range_option(item["values"], "values")}
            if "categories" in item:
                series_options["categories"] = range_option(item["categories"], "categories")
            if "name" in item:
                series_options["name"] = clean_text(item["name"])
            chart.add_series(series_options)
        if "title" in spec:
            chart.set_title({"name": clean_text(spec["title"])})
        if "legend" in spec:
            chart.set_legend({"position": clean_text(spec["legend"])})
        if "style" in spec:
            style = int(spec["style"])
            if style < 1 or style > 48:
                raise InputError("chart style must be from 1 through 48")
            chart.set_style(style)
        position = spec.get("position", "F2")
        if not isinstance(position, str) or not re.fullmatch(r"[A-Za-z]{1,3}[1-9]\d*", position):
            raise InputError("chart position must be a cell such as F2")
        insert_options = {}
        for key in ("width", "height"):
            if key in spec:
                insert_options[key] = max(50, min(4000, int(spec[key])))
        worksheet.insert_chart(position, chart, insert_options)


def write_sheet(workbook, formats: FormatCache, sheet: dict):
    if not isinstance(sheet, dict):
        raise InputError("each sheet must be an object")
    name = validate_sheet_name(sheet.get("name", "Sheet1"))
    rows = sheet.get("rows")
    if not isinstance(rows, list):
        raise InputError(f"sheet {name} needs a rows array")
    columns, matrix, generated_header = normalize_columns(sheet, rows)
    header = bool(sheet.get("header", True))
    if not generated_header and header and matrix:
        header_values = matrix.pop(0)
    elif header:
        header_values = [column["header"] for column in columns]
    else:
        header_values = None

    total_rows = len(matrix) + (1 if header_values is not None else 0)
    if total_rows > MAX_ROWS:
        raise InputError(f"sheet {name} has more than Excel's {MAX_ROWS}-row limit")

    worksheet = workbook.add_worksheet(name)
    header_format = formats.get("header", sheet.get("headerFormat"))
    widths = [len(clean_text(value)) if value is not None else 0 for value in (header_values or [""] * len(columns))]
    row_offset = 0
    if header_values is not None:
        for col, value in enumerate(header_values):
            worksheet.write_string(0, col, clean_text(value), header_format)
        worksheet.set_row(0, 24)
        row_offset = 1

    for row_index, row in enumerate(matrix, start=row_offset):
        if len(row) > MAX_COLUMNS:
            raise InputError(f"sheet {name} has more than Excel's {MAX_COLUMNS}-column limit")
        for col_index, value in enumerate(row):
            column = columns[col_index]
            write_cell(worksheet, row_index, col_index, value, formats, column.get("format"))
            display = value.get("formula", value.get("value", "")) if isinstance(value, dict) else value
            widths[col_index] = min(60, max(widths[col_index], len(clean_text(display))))

    for index, column in enumerate(columns):
        requested = column.get("width")
        width = float(requested) if requested is not None else min(60, max(10, widths[index] + 2))
        if not math.isfinite(width) or width <= 0 or width > 255:
            raise InputError(f"invalid width for column {column['key']}")
        worksheet.set_column(index, index, width, formats.get(column.get("format")))

    freeze = sheet.get("freeze", True)
    if freeze is True and header_values is not None:
        worksheet.freeze_panes(1, 0)
    elif isinstance(freeze, dict):
        freeze_row = int(freeze.get("row", 0))
        freeze_col = int(freeze.get("column", 0))
        if freeze_row < 0 or freeze_col < 0:
            raise InputError("freeze row and column must be zero or greater")
        worksheet.freeze_panes(freeze_row, freeze_col)
    elif freeze not in (False, None):
        raise InputError("freeze must be true, false, or an object")

    if sheet.get("filter", True) and header_values is not None and total_rows > 0:
        worksheet.autofilter(0, 0, max(0, total_rows - 1), len(columns) - 1)

    worksheet.hide_gridlines(2 if sheet.get("hideGridlines", False) else 0)
    add_charts(workbook, worksheet, sheet.get("charts"))


def parse_delimited(text: str, delimiter: str, name: str) -> dict:
    try:
        rows = list(csv.reader(io.StringIO(text, newline=""), delimiter=delimiter))
    except csv.Error as exc:
        raise InputError(f"invalid delimited file: {exc}") from exc
    if not rows or not any(any(cell for cell in row) for row in rows):
        raise InputError("input is empty")
    width = max(len(row) for row in rows)
    if width > MAX_COLUMNS or len(rows) > MAX_ROWS:
        raise InputError("input exceeds Excel's row or column limit")
    normalized = []
    for row_index, row in enumerate(rows):
        values = [clean_text(value) if row_index == 0 else infer_delimited_value(value) for value in row]
        normalized.append(values + [None] * (width - len(values)))
    return {"sheets": [{"name": default_sheet_name(name), "rows": normalized, "header": True}]}


def parse_json_model(text: str, default_name: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise InputError(f"invalid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}") from exc
    if isinstance(data, list):
        return {"sheets": [{"name": default_sheet_name(default_name), "rows": data}]}
    if not isinstance(data, dict):
        raise InputError("JSON input must be an object or row array")
    if "sheets" not in data and "rows" in data:
        data = {"sheets": [{**data, "name": data.get("name", default_sheet_name(default_name))}]}
    sheets = data.get("sheets")
    if not isinstance(sheets, list) or not sheets:
        raise InputError("JSON input needs a non-empty sheets array")
    seen = set()
    for sheet in sheets:
        if not isinstance(sheet, dict):
            raise InputError("each sheet must be an object")
        name = validate_sheet_name(sheet.get("name", "Sheet1"))
        key = name.casefold()
        if key in seen:
            raise InputError(f"duplicate sheet name: {name}")
        seen.add(key)
    return data


def validate_xlsx(path: Path) -> None:
    required = {"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"}
    try:
        with zipfile.ZipFile(path, "r") as archive:
            names = set(archive.namelist())
            missing = required - names
            if missing:
                raise InputError(f"XLSX output is missing {sorted(missing)[0]}")
            bad = archive.testzip()
            if bad:
                raise InputError(f"XLSX output has a corrupt ZIP entry: {bad}")
            for name in required:
                if name.endswith(".xml"):
                    ET.fromstring(archive.read(name))
    except (zipfile.BadZipFile, ET.ParseError) as exc:
        raise InputError(f"XLSX output validation failed: {exc}") from exc


def create_xlsx_atomic(model: dict, output_path: Path) -> Path:
    output = output_path.resolve()
    if output.suffix.lower() != ".xlsx":
        raise InputError("output path must end in .xlsx")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output.name}.tmp-", suffix=".xlsx", dir=output.parent)
    os.close(fd)
    temp = Path(temp_name)
    workbook = None
    try:
        workbook = xlsxwriter.Workbook(temp, {"strings_to_formulas": False, "strings_to_urls": False, "constant_memory": False})
        properties = model.get("properties", {})
        if properties:
            if not isinstance(properties, dict):
                raise InputError("properties must be an object")
            allowed = {"title", "subject", "author", "manager", "company", "category", "keywords", "comments", "status"}
            unknown = set(properties) - allowed
            if unknown:
                raise InputError(f"unsupported workbook property: {sorted(unknown)[0]}")
            workbook.set_properties({key: clean_text(value) for key, value in properties.items()})
        formats = FormatCache(workbook)
        for sheet in model["sheets"]:
            write_sheet(workbook, formats, sheet)
        workbook.close()
        workbook = None
        validate_xlsx(temp)
        os.replace(temp, output)
        return output
    except Exception:
        if workbook is not None:
            try:
                workbook.close()
            except Exception:
                pass
        try:
            temp.unlink()
        except FileNotFoundError:
            pass
        raise


def detect_format(input_name: str, text: str, hint: str) -> str:
    if hint != "auto":
        return hint
    suffix = Path(input_name).suffix.lower()
    if suffix == ".csv":
        return "csv"
    if suffix in (".tsv", ".tab"):
        return "tsv"
    if suffix == ".json":
        return "json"
    return "json" if text.lstrip().startswith(("{", "[")) else "csv"


def read_input(name: str) -> str:
    if name == "-":
        data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    else:
        path = Path(name)
        if not path.is_file():
            raise InputError(f"input is not a file: {name}")
        if path.stat().st_size > MAX_INPUT_BYTES:
            raise InputError("input is larger than 64 MB")
        data = path.read_bytes()
    if len(data) > MAX_INPUT_BYTES:
        raise InputError("input is larger than 64 MB")
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise InputError("input must use UTF-8 text") from exc


def output_path(input_name: str, requested: str | None) -> Path:
    if requested:
        return Path(requested).resolve()
    if input_name == "-":
        return (Path.cwd() / "workbook.xlsx").resolve()
    return (Path.cwd() / f"{Path(input_name).stem}.xlsx").resolve()


def argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Make a safe XLSX workbook from CSV, TSV, or structured JSON.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Structured JSON example:
  {"sheets":[{"name":"Sales","columns":[
    {"key":"month","header":"Month","width":16},
    {"key":"amount","header":"Amount","format":"currency"}],
    "rows":[{"month":"July","amount":1200.5}],
    "charts":[{"type":"column","series":[{"name":"Amount",
      "categories":"=Sales!$A$2:$A$2","values":"=Sales!$B$2:$B$2"}],
      "position":"E2"}]}]}

Cell objects can use {"value":"2026-08-05","type":"date"}, a format
preset or object, or {"formula":"=SUM(B2:B10)","result":0}. Plain text,
including CSV text that starts with =, +, -, or @, never becomes a formula.
Presets: currency, integer, decimal, percent, date, datetime, text.""",
    )
    parser.add_argument("input", nargs="?", default="-", help="input file, or - for stdin")
    parser.add_argument("-o", "--output", help="output .xlsx path")
    parser.add_argument("--from", dest="source_format", choices=("auto", "csv", "tsv", "json"), default="auto", help="input format")
    parser.add_argument("--sheet-name", help="sheet name for CSV, TSV, or simple JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    if xlsxwriter.__version__ != PINNED_XLSXWRITER_VERSION:
        raise RuntimeError(f"expected vendored XlsxWriter {PINNED_XLSXWRITER_VERSION}, got {xlsxwriter.__version__}")
    args = argument_parser().parse_args(argv)
    text = read_input(args.input)
    if not text.strip():
        raise InputError("input is empty")
    source_format = detect_format(args.input, text, args.source_format)
    default_name = args.sheet_name or ("Sheet1" if args.input == "-" else Path(args.input).stem)
    if args.sheet_name:
        validate_sheet_name(args.sheet_name)
    if source_format == "csv":
        model = parse_delimited(text, ",", default_name)
    elif source_format == "tsv":
        model = parse_delimited(text, "\t", default_name)
    else:
        model = parse_json_model(text, default_name)
        if args.sheet_name and len(model["sheets"]) == 1:
            model["sheets"][0]["name"] = args.sheet_name
    output = create_xlsx_atomic(model, output_path(args.input, args.output))
    print(output)
    print("veneer-xlsx: created and validated XLSX.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InputError, OSError, ValueError, TypeError) as exc:
        print(f"veneer-xlsx: {exc}", file=sys.stderr)
        raise SystemExit(1)
