"""Memory-safe CSV/TSV inspection for large tabular files.

This script streams delimited text rows with Python's csv module and preserves
cell values as strings. It is intended as a first pass before pandas or any
typed conversion, especially for files that may contain identifiers, long
integers, high-precision decimals, or formula-like text.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from pathlib import Path
from typing import Any

DELIMITER_CANDIDATES = ",\t;|"
LEADING_ZERO_RE = re.compile(r"^[+]?(?:0\d+)$")
LONG_INTEGER_RE = re.compile(r"^[+-]?\d{16,}$")
DECIMAL_RE = re.compile(r"^[+-]?(?:\d+\.\d+|\.\d+)$")
SCIENTIFIC_RE = re.compile(r"^[+-]?(?:\d+(?:\.\d+)?|\.\d+)[eE][+-]?\d+$")
NEGATIVE_NUMBER_RE = re.compile(r"^-\d+(?:\.\d+)?$")


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return parsed


def _read_probe(path: Path, byte_limit: int) -> bytes:
    with path.open("rb") as handle:
        return handle.read(byte_limit)


def _candidate_encodings(raw: bytes, preferred: str) -> list[str]:
    encodings: list[str] = []
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        encodings.append("utf-16")
    elif raw.startswith(b"\xef\xbb\xbf"):
        encodings.append("utf-8-sig")
    if preferred:
        encodings.append(preferred)
    encodings.extend(["utf-8-sig", "utf-8", "cp1252", "latin-1"])
    deduped: list[str] = []
    for encoding in encodings:
        if encoding not in deduped:
            deduped.append(encoding)
    return deduped


def _detect_encoding(raw: bytes, preferred: str) -> tuple[str, bool, str]:
    for encoding in _candidate_encodings(raw, preferred):
        try:
            raw.decode(encoding)
            return encoding, False, raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return "utf-8", True, raw.decode("utf-8", errors="replace")


def _normalize_delimiter(value: str | None) -> str | None:
    if value is None or value == "":
        return None
    if value == "\\t":
        return "\t"
    return value


def _detect_delimiter(probe_text: str, suffix: str, explicit: str | None) -> tuple[str, str]:
    normalized = _normalize_delimiter(explicit)
    if normalized:
        return normalized, "explicit"
    if suffix.casefold() == ".tsv":
        return "\t", "extension"
    try:
        dialect = csv.Sniffer().sniff(probe_text, delimiters=DELIMITER_CANDIDATES)
        return dialect.delimiter, "sniffer"
    except csv.Error:
        pass
    lines = [line for line in probe_text.splitlines()[:20] if line.strip()]
    if lines:
        counts = {
            delimiter: sum(line.count(delimiter) for line in lines)
            for delimiter in DELIMITER_CANDIDATES
        }
        delimiter = max(counts, key=counts.get)
        if counts[delimiter] > 0:
            return delimiter, "frequency"
    return ",", "fallback"


def _detect_header(probe_text: str, header_mode: str) -> bool | None:
    if header_mode == "yes":
        return True
    if header_mode == "no":
        return False
    try:
        return bool(csv.Sniffer().has_header(probe_text))
    except csv.Error:
        return None


def _truncate(value: str, limit: int) -> dict[str, Any]:
    if limit > 0 and len(value) > limit:
        return {"value": value[:limit], "truncated": True, "raw_length": len(value)}
    return {"value": value, "truncated": False, "raw_length": len(value)}


def _is_formula_like(text: str) -> bool:
    if not text:
        return False
    if text[0] in {"=", "@", "+"}:
        return True
    if text[0] == "-" and not NEGATIVE_NUMBER_RE.match(text):
        return True
    return False


def _blank_profile(index: int, name: str) -> dict[str, Any]:
    return {
        "index": index,
        "name": name,
        "non_empty_count": 0,
        "blank_count": 0,
        "max_chars_seen": 0,
        "sample_values": [],
        "_risk_flags": set(),
        "_counts": {
            "leading_zero_text": 0,
            "long_integer": 0,
            "high_precision_decimal": 0,
            "scientific_notation": 0,
            "formula_like": 0,
            "whitespace_sensitive": 0,
            "long_cell": 0,
        },
    }


def _ensure_profiles(
    profiles: list[dict[str, Any]],
    row_width: int,
    *,
    names: list[str],
    max_profile_columns: int,
) -> None:
    target = min(row_width, max_profile_columns)
    while len(profiles) < target:
        index = len(profiles)
        name = names[index] if index < len(names) and names[index] else f"column_{index + 1}"
        profiles.append(_blank_profile(index + 1, name))


def _add_risk(profile: dict[str, Any], flag: str) -> None:
    profile["_risk_flags"].add(flag)
    profile["_counts"][flag] += 1


def _profile_cell(profile: dict[str, Any], value: str, *, value_char_limit: int) -> None:
    text = value.strip()
    profile["max_chars_seen"] = max(int(profile["max_chars_seen"]), len(value))
    if not text:
        profile["blank_count"] += 1
        return

    profile["non_empty_count"] += 1
    samples = profile["sample_values"]
    if len(samples) < 3 and value not in samples:
        samples.append(value[:value_char_limit] if value_char_limit > 0 else value)

    if value != text:
        _add_risk(profile, "whitespace_sensitive")
    if value_char_limit > 0 and len(value) > value_char_limit:
        _add_risk(profile, "long_cell")
    if LEADING_ZERO_RE.match(text) and len(text.lstrip("+")) > 1:
        _add_risk(profile, "leading_zero_text")
    if LONG_INTEGER_RE.match(text):
        _add_risk(profile, "long_integer")
    decimal_match = DECIMAL_RE.match(text)
    if decimal_match and len(text.split(".", 1)[1]) > 10:
        _add_risk(profile, "high_precision_decimal")
    if SCIENTIFIC_RE.match(text):
        _add_risk(profile, "scientific_notation")
    if _is_formula_like(text):
        _add_risk(profile, "formula_like")


def _public_profile(profile: dict[str, Any]) -> dict[str, Any]:
    counts = dict(profile["_counts"])
    return {
        "index": profile["index"],
        "name": profile["name"],
        "non_empty_count": profile["non_empty_count"],
        "blank_count": profile["blank_count"],
        "max_chars_seen": profile["max_chars_seen"],
        "sample_values": profile["sample_values"],
        "risk_flags": sorted(profile["_risk_flags"]),
        "risk_counts": {key: value for key, value in counts.items() if value},
    }


def _sample_row(row_number: int, row: list[str], *, value_char_limit: int) -> dict[str, Any]:
    return {
        "row": row_number,
        "cells": [_truncate(value, value_char_limit) for value in row],
    }


def _recommendations(payload: dict[str, Any]) -> list[str]:
    recommendations = [
        "Use this inspection for discovery only; do not use sampled rows for exact totals or statistics.",
        "Preserve raw cell values as strings until a column schema is chosen.",
        "For exact results, stream the full file and verify input row counts against output/check totals.",
    ]
    if payload.get("scan_truncated"):
        recommendations.append(
            "scan_truncated=true means counts and column profiles are partial; rerun with a higher max_rows_scan or stream all rows before making exact claims."
        )
    profiles = list(payload.get("columns") or [])
    precision_flags = {"leading_zero_text", "long_integer", "high_precision_decimal", "scientific_notation"}
    if any(set(column.get("risk_flags") or []) & precision_flags for column in profiles):
        recommendations.append(
            "Flagged identifier, long-integer, and decimal columns must not be inferred as float; use dtype=str, Decimal, or integer minor units."
        )
    if any("formula_like" in set(column.get("risk_flags") or []) for column in profiles):
        recommendations.append(
            "Formula-like CSV values can execute in spreadsheet apps; escape or quote them when exporting to Excel/CSV deliverables."
        )
    if int(payload.get("file_size_bytes") or 0) > 100_000_000:
        recommendations.append(
            "For pandas workflows, use read_csv(..., chunksize=..., dtype=...) after this schema pass instead of reading the whole file."
        )
    return recommendations


def inspect_tabular_file(
    path: Path,
    *,
    delimiter: str | None,
    encoding: str,
    header: str,
    probe_bytes: int,
    sample_rows: int,
    max_rows_scan: int,
    max_profile_columns: int,
    value_char_limit: int,
) -> dict[str, Any]:
    raw_probe = _read_probe(path, probe_bytes)
    detected_encoding, decode_replacement, probe_text = _detect_encoding(raw_probe, encoding)
    detected_delimiter, delimiter_source = _detect_delimiter(
        probe_text,
        path.suffix,
        delimiter,
    )
    has_header = _detect_header(probe_text, header)

    row_count_scanned = 0
    data_row_count_scanned = 0
    max_column_seen = 0
    ragged_row_count = 0
    expected_width: int | None = None
    scan_truncated = False
    sample_payload: list[dict[str, Any]] = []
    header_row: list[str] = []
    profiles: list[dict[str, Any]] = []

    with path.open("r", encoding=detected_encoding, errors="replace", newline="") as handle:
        reader = csv.reader(handle, delimiter=detected_delimiter)
        for row_number, row in enumerate(reader, start=1):
            row_count_scanned += 1
            max_column_seen = max(max_column_seen, len(row))
            if expected_width is None:
                expected_width = len(row)
            elif len(row) != expected_width:
                ragged_row_count += 1
            if len(sample_payload) < sample_rows:
                sample_payload.append(
                    _sample_row(row_number, row, value_char_limit=value_char_limit)
                )

            if row_number == 1 and has_header is True:
                header_row = row
                _ensure_profiles(
                    profiles,
                    len(row),
                    names=header_row,
                    max_profile_columns=max_profile_columns,
                )
            else:
                data_row_count_scanned += 1
                _ensure_profiles(
                    profiles,
                    len(row),
                    names=header_row,
                    max_profile_columns=max_profile_columns,
                )
                for index, value in enumerate(row[:max_profile_columns]):
                    _profile_cell(profiles[index], value, value_char_limit=value_char_limit)

            if max_rows_scan > 0 and row_count_scanned >= max_rows_scan:
                scan_truncated = True
                break

    payload: dict[str, Any] = {
        "protocol": "bush.tabular_file_inspection.v1",
        "file_path": str(path.resolve(strict=False)),
        "file_size_bytes": path.stat().st_size,
        "encoding": {
            "selected": detected_encoding,
            "decode_replacement_used": decode_replacement,
        },
        "delimiter": detected_delimiter,
        "delimiter_source": delimiter_source,
        "has_header": has_header,
        "header": header_row,
        "row_count_scanned": row_count_scanned,
        "data_row_count_scanned": data_row_count_scanned,
        "max_column_seen": max_column_seen,
        "profiled_column_count": len(profiles),
        "unprofiled_column_count": max(0, max_column_seen - len(profiles)),
        "ragged_row_count": ragged_row_count,
        "scan_truncated": scan_truncated,
        "limits": {
            "probe_bytes": probe_bytes,
            "sample_rows": sample_rows,
            "max_rows_scan": max_rows_scan,
            "max_profile_columns": max_profile_columns,
            "value_char_limit": value_char_limit,
        },
        "sample_rows": sample_payload,
        "columns": [_public_profile(profile) for profile in profiles],
    }
    payload["recommendations"] = _recommendations(payload)
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect a CSV/TSV file without loading it into memory."
    )
    parser.add_argument("file", help="Path to .csv/.tsv or another delimited text file")
    parser.add_argument("--delimiter", help="Delimiter character; use \\t for tab")
    parser.add_argument("--encoding", default="utf-8-sig")
    parser.add_argument("--header", choices=["auto", "yes", "no"], default="auto")
    parser.add_argument("--probe-bytes", type=_positive_int, default=65536)
    parser.add_argument("--sample-rows", type=_positive_int, default=20)
    parser.add_argument("--max-rows-scan", type=_positive_int, default=250000)
    parser.add_argument("--max-profile-columns", type=_positive_int, default=200)
    parser.add_argument("--value-char-limit", type=_positive_int, default=200)
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = parser.parse_args(argv)

    path = Path(args.file)
    if not path.exists():
        print(json.dumps({"error": f"file not found: {path}"}, ensure_ascii=False))
        return 2
    if path.suffix.casefold() in {".xlsx", ".xlsm"}:
        print(
            json.dumps(
                {"error": "inspect_tabular_file.py expects delimited text, not .xlsx/.xlsm"},
                ensure_ascii=False,
            )
        )
        return 2

    payload = inspect_tabular_file(
        path,
        delimiter=args.delimiter,
        encoding=args.encoding,
        header=args.header,
        probe_bytes=args.probe_bytes,
        sample_rows=args.sample_rows,
        max_rows_scan=args.max_rows_scan,
        max_profile_columns=args.max_profile_columns,
        value_char_limit=args.value_char_limit,
    )
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
