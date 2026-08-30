"""Memory-safe XLSX inspection for large workbooks.

This script reads XLSX zip/XML parts directly and samples worksheet rows without
loading a full workbook into memory. It is intended as the first pass before an
agent decides whether pandas/openpyxl normal mode is safe.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import re
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
CELL_REF_RE = re.compile(r"^([A-Z]+)([0-9]+)$", re.IGNORECASE)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _child_text(elem: ET.Element, name: str) -> str:
    for child in list(elem):
        if _local_name(child.tag) == name:
            return child.text or ""
    return ""


def _inline_string(elem: ET.Element) -> str:
    parts: list[str] = []
    for child in elem.iter():
        if _local_name(child.tag) == "t" and child.text:
            parts.append(child.text)
    return "".join(parts)


def _column_index(cell_ref: str) -> int:
    match = CELL_REF_RE.match(str(cell_ref or ""))
    if not match:
        return 0
    total = 0
    for char in match.group(1).upper():
        total = total * 26 + (ord(char) - ord("A") + 1)
    return total


def _dimension_bounds(ref: str) -> dict[str, int]:
    text = str(ref or "").strip()
    if not text:
        return {}
    last = text.split(":")[-1]
    match = CELL_REF_RE.match(last)
    if not match:
        return {}
    return {"max_row": int(match.group(2)), "max_column": _column_index(last)}


def _normalize_sheet_target(target: str) -> str:
    text = str(target or "").replace("\\", "/").lstrip("/")
    if text.startswith("xl/"):
        return posixpath.normpath(text)
    return posixpath.normpath(posixpath.join("xl", text))


def _parse_relationships(zf: zipfile.ZipFile) -> dict[str, str]:
    rel_path = "xl/_rels/workbook.xml.rels"
    if rel_path not in zf.namelist():
        return {}
    relationships: dict[str, str] = {}
    with zf.open(rel_path) as handle:
        root = ET.parse(handle).getroot()
    for rel in root:
        if _local_name(rel.tag) != "Relationship":
            continue
        rel_id = str(rel.attrib.get("Id") or "")
        target = str(rel.attrib.get("Target") or "")
        if rel_id and target:
            relationships[rel_id] = _normalize_sheet_target(target)
    return relationships


def _parse_workbook_sheets(zf: zipfile.ZipFile) -> list[dict[str, str]]:
    if "xl/workbook.xml" not in zf.namelist():
        return []
    relationships = _parse_relationships(zf)
    with zf.open("xl/workbook.xml") as handle:
        root = ET.parse(handle).getroot()
    sheets: list[dict[str, str]] = []
    for elem in root.iter():
        if _local_name(elem.tag) != "sheet":
            continue
        rel_id = str(elem.attrib.get(f"{REL_NS}id") or elem.attrib.get("id") or "")
        path = relationships.get(rel_id, "")
        sheets.append(
            {
                "name": str(elem.attrib.get("name") or ""),
                "sheet_id": str(elem.attrib.get("sheetId") or ""),
                "relationship_id": rel_id,
                "path": path,
            }
        )
    return sheets


def _resolve_shared_strings(
    zf: zipfile.ZipFile,
    wanted_indices: set[int],
    *,
    limit: int,
) -> dict[int, str]:
    if not wanted_indices or "xl/sharedStrings.xml" not in zf.namelist():
        return {}
    resolved: dict[int, str] = {}
    with zf.open("xl/sharedStrings.xml") as handle:
        index = -1
        for event, elem in ET.iterparse(handle, events=("end",)):
            if _local_name(elem.tag) != "si":
                continue
            index += 1
            if index in wanted_indices:
                resolved[index] = _inline_string(elem)[:limit]
                if len(resolved) == len(wanted_indices):
                    elem.clear()
                    break
            elem.clear()
    return resolved


def _inspect_shared_strings(zf: zipfile.ZipFile) -> dict[str, Any]:
    path = "xl/sharedStrings.xml"
    if path not in zf.namelist():
        return {"present": False, "count": 0, "unique_count": 0}
    try:
        with zf.open(path) as handle:
            root = ET.iterparse(handle, events=("start",))
            _, elem = next(root)
            return {
                "present": True,
                "count": int(elem.attrib.get("count") or 0),
                "unique_count": int(elem.attrib.get("uniqueCount") or 0),
            }
    except Exception:
        return {"present": True, "count": 0, "unique_count": 0}


def _inspect_sheet(
    zf: zipfile.ZipFile,
    sheet: dict[str, str],
    *,
    sample_rows: int,
    max_rows_scan: int,
    value_char_limit: int,
) -> tuple[dict[str, Any], set[int]]:
    path = sheet.get("path") or ""
    if not path or path not in zf.namelist():
        payload = dict(sheet)
        payload.update({"status": "missing_xml", "row_count": 0, "cell_count": 0})
        return payload, set()

    row_count = 0
    cell_count = 0
    formula_count = 0
    error_cell_count = 0
    max_row_seen = 0
    max_column_seen = 0
    dimension: dict[str, int] = {}
    samples: list[dict[str, Any]] = []
    wanted_shared_strings: set[int] = set()
    current_row: dict[str, Any] | None = None
    scan_truncated = False

    with zf.open(path) as handle:
        for event, elem in ET.iterparse(handle, events=("start", "end")):
            name = _local_name(elem.tag)
            if event == "start" and name == "dimension":
                dimension = _dimension_bounds(str(elem.attrib.get("ref") or ""))
            elif event == "start" and name == "row":
                raw_row = elem.attrib.get("r")
                row_index = int(raw_row) if str(raw_row or "").isdigit() else row_count + 1
                current_row = {"row": row_index, "cells": []}
            elif event == "end" and name == "c":
                cell_count += 1
                cell_ref = str(elem.attrib.get("r") or "")
                cell_type = str(elem.attrib.get("t") or "")
                raw_value = _child_text(elem, "v")
                formula = _child_text(elem, "f")
                if formula:
                    formula_count += 1
                if cell_type == "e" or raw_value.startswith("#"):
                    error_cell_count += 1
                max_column_seen = max(max_column_seen, _column_index(cell_ref))
                if current_row is not None and len(samples) < sample_rows:
                    cell_payload: dict[str, Any] = {
                        "ref": cell_ref,
                        "type": cell_type or "n",
                    }
                    if formula:
                        cell_payload["formula"] = formula[:value_char_limit]
                    if cell_type == "inlineStr":
                        cell_payload["value"] = _inline_string(elem)[:value_char_limit]
                    elif raw_value:
                        cell_payload["raw_value"] = raw_value[:value_char_limit]
                        if cell_type == "s" and raw_value.isdigit():
                            wanted_shared_strings.add(int(raw_value))
                            cell_payload["shared_string_index"] = int(raw_value)
                    current_row["cells"].append(cell_payload)
                elem.clear()
            elif event == "end" and name == "row":
                row_count += 1
                if current_row is not None:
                    max_row_seen = max(max_row_seen, int(current_row.get("row") or row_count))
                    if len(samples) < sample_rows:
                        samples.append(current_row)
                current_row = None
                elem.clear()
                if max_rows_scan > 0 and row_count >= max_rows_scan:
                    scan_truncated = True
                    break

    payload = dict(sheet)
    payload.update(
        {
            "status": "ok",
            "row_count_scanned": row_count,
            "cell_count_scanned": cell_count,
            "formula_count_scanned": formula_count,
            "error_cell_count_scanned": error_cell_count,
            "scan_truncated": scan_truncated,
            "dimension": dimension,
            "max_row_seen": max_row_seen,
            "max_column_seen": max_column_seen,
            "sample_rows": samples,
        }
    )
    return payload, wanted_shared_strings


def _apply_shared_string_samples(
    sheets: list[dict[str, Any]],
    shared_strings: dict[int, str],
) -> None:
    for sheet in sheets:
        for row in list(sheet.get("sample_rows") or []):
            for cell in list(row.get("cells") or []):
                index = cell.get("shared_string_index")
                if isinstance(index, int) and index in shared_strings:
                    cell["value"] = shared_strings[index]


def _recommendations(payload: dict[str, Any]) -> list[str]:
    recommendations = [
        "Use this inspection before pandas/openpyxl normal mode on unknown workbooks.",
        "Prefer openpyxl read_only=True or XML/CSV streaming for large sheets.",
    ]
    total_cells = sum(
        int(sheet.get("cell_count_scanned") or 0)
        for sheet in list(payload.get("sheets") or [])
    )
    if total_cells > 500_000:
        recommendations.append(
            "Avoid pd.read_excel(sheet_name=None); read targeted sheets/columns or stream to chunked CSV/parquet first."
        )
    if any(bool(sheet.get("scan_truncated")) for sheet in list(payload.get("sheets") or [])):
        recommendations.append(
            "At least one sheet hit max_rows_scan; rerun with a higher limit only if full counts are required."
        )
    if int((payload.get("shared_strings") or {}).get("unique_count") or 0) > 200_000:
        recommendations.append(
            "Shared strings are large; resolve only sampled/header strings instead of loading all strings."
        )
    return recommendations


def inspect_workbook(
    workbook_path: Path,
    *,
    sheet_names: list[str],
    sample_rows: int,
    max_sheets: int,
    max_rows_scan: int,
    value_char_limit: int,
) -> dict[str, Any]:
    selected = {name.casefold() for name in sheet_names if name.strip()}
    with zipfile.ZipFile(workbook_path) as zf:
        workbook_sheets_all = _parse_workbook_sheets(zf)
        workbook_sheets = list(workbook_sheets_all)
        if selected:
            workbook_sheets = [
                sheet for sheet in workbook_sheets if sheet.get("name", "").casefold() in selected
            ]
        if max_sheets > 0:
            workbook_sheets = workbook_sheets[:max_sheets]
        inspected_sheets: list[dict[str, Any]] = []
        wanted_shared_strings: set[int] = set()
        for sheet in workbook_sheets:
            sheet_payload, wanted = _inspect_sheet(
                zf,
                sheet,
                sample_rows=sample_rows,
                max_rows_scan=max_rows_scan,
                value_char_limit=value_char_limit,
            )
            inspected_sheets.append(sheet_payload)
            wanted_shared_strings.update(wanted)
        shared_strings = _inspect_shared_strings(zf)
        resolved_strings = _resolve_shared_strings(
            zf,
            wanted_shared_strings,
            limit=value_char_limit,
        )
        _apply_shared_string_samples(inspected_sheets, resolved_strings)

    payload: dict[str, Any] = {
        "protocol": "bush.xlsx.large_workbook_inspection.v1",
        "workbook_path": str(workbook_path.resolve(strict=False)),
        "file_size_bytes": workbook_path.stat().st_size,
        "sheet_count": len(workbook_sheets_all),
        "inspected_sheet_count": len(inspected_sheets),
        "shared_strings": shared_strings,
        "limits": {
            "sample_rows": sample_rows,
            "max_sheets": max_sheets,
            "max_rows_scan": max_rows_scan,
            "value_char_limit": value_char_limit,
        },
        "sheets": inspected_sheets,
    }
    payload["recommendations"] = _recommendations(payload)
    return payload


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return parsed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect a large XLSX workbook without loading it into memory."
    )
    parser.add_argument("workbook", help="Path to .xlsx workbook")
    parser.add_argument("--sheet", action="append", default=[], help="Sheet name to inspect")
    parser.add_argument("--sample-rows", type=_positive_int, default=20)
    parser.add_argument("--max-sheets", type=_positive_int, default=20)
    parser.add_argument("--max-rows-scan", type=_positive_int, default=250000)
    parser.add_argument("--value-char-limit", type=_positive_int, default=200)
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = parser.parse_args(argv)

    workbook_path = Path(args.workbook)
    if not workbook_path.exists():
        print(json.dumps({"error": f"file not found: {workbook_path}"}, ensure_ascii=False))
        return 2
    if workbook_path.suffix.casefold() not in {".xlsx", ".xlsm"}:
        print(json.dumps({"error": "inspect_large_workbook.py expects .xlsx or .xlsm"}, ensure_ascii=False))
        return 2

    try:
        payload = inspect_workbook(
            workbook_path,
            sheet_names=list(args.sheet or []),
            sample_rows=args.sample_rows,
            max_sheets=args.max_sheets,
            max_rows_scan=args.max_rows_scan,
            value_char_limit=args.value_char_limit,
        )
    except zipfile.BadZipFile:
        print(json.dumps({"error": "invalid Office zip container"}, ensure_ascii=False))
        return 2

    print(
        json.dumps(
            payload,
            ensure_ascii=False,
            indent=2 if args.pretty else None,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
