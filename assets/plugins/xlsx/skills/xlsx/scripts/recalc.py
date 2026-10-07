#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 CardBush contributors
"""Recalculate a plain XLSX into a new file using an installed LibreOffice."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
EXTERNAL_FUNCTION = re.compile(r"(?<![A-Z0-9_])(?:WEBSERVICE|DDE|RTD|CUBEVALUE|CUBEMEMBER)\s*\(", re.I)


def find_soffice(explicit=None):
    candidates = [explicit] if explicit else [os.environ.get("SOFFICE_PATH")]
    if not explicit:
        candidates.extend(["soffice.com", "soffice.exe"] if os.name == "nt" else ["soffice", "libreoffice"])
        if os.name == "nt":
            for variable in ("ProgramFiles", "ProgramFiles(x86)"):
                if os.environ.get(variable):
                    candidates.append(str(Path(os.environ[variable]) / "LibreOffice/program/soffice.com"))
    for candidate in filter(None, candidates):
        found = shutil.which(str(candidate))
        if found:
            return found
        if Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise FileNotFoundError("LibreOffice not found; use --soffice or SOFFICE_PATH.")


class XMLReader:
    """Reject DTD/entity declarations while streaming, including split tokens."""

    def __init__(self, source):
        self.source, self.tail = source, b""

    def read(self, size=-1):
        chunk = self.source.read(size)
        probe = self.tail + chunk.replace(b"\0", b"").upper()
        if b"<!DOCTYPE" in probe or b"<!ENTITY" in probe:
            raise ValueError("XML DTD/entity declarations are unsupported.")
        self.tail = probe[-16:]
        return chunk


def scan_workbook(file):
    formulas, errors, missing, sheets = set(), [], [], []
    error_count = missing_count = cell_count = 0
    with zipfile.ZipFile(file) as package:
        entries = package.infolist()
        if len(entries) > 20000 or sum(item.file_size for item in entries) > 512 * 1024 * 1024:
            raise ValueError("Workbook exceeds this helper's package inspection limit.")
        if len({item.filename for item in entries}) != len(entries):
            raise ValueError("Duplicate OOXML part names are unsupported.")
        names = [item.filename.lower() for item in entries]
        if any("vbaproject" in name or name.startswith(("xl/externallinks/", "xl/querytables/", "xl/embeddings/", "_xmlsignatures/"))
               or name == "xl/connections.xml" for name in names):
            raise ValueError("Macros, external data connections and signed workbooks are unsupported.")

        def metadata(name):
            if package.getinfo(name).file_size > 4 * 1024 * 1024:
                raise ValueError("Oversized workbook metadata.")
            with package.open(name) as stream:
                return ET.parse(XMLReader(stream)).getroot()

        book = metadata("xl/workbook.xml")
        links = {item.attrib["Id"]: item for item in metadata("xl/_rels/workbook.xml.rels")}
        sheet_list = book.find(SHEET_NS + "sheets")
        if sheet_list is None:
            raise ValueError("Workbook has no worksheet declarations.")
        for sheet in sheet_list:
            title = sheet.attrib["name"]
            sheets.append(title)
            link = links[sheet.attrib[REL_NS + "id"]]
            if link.get("TargetMode") == "External":
                raise ValueError("External worksheet references are unsupported.")
            target = link.attrib["Target"]
            member = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
            if not member.startswith("xl/worksheets/") or not member.endswith(".xml"):
                raise ValueError("Only ordinary worksheets are supported.")
            if package.getinfo(member).file_size > 128 * 1024 * 1024:
                raise ValueError("Worksheet exceeds this helper's inspection limit.")
            with package.open(member) as stream:
                sheet_data = None
                for event, element in ET.iterparse(XMLReader(stream), events=("start", "end")):
                    if event == "start" and element.tag == SHEET_NS + "sheetData":
                        sheet_data = element
                    if event != "end":
                        continue
                    if element.tag == SHEET_NS + "c":
                        cell_count += 1
                        if cell_count > 2_000_000:
                            raise ValueError("Workbook exceeds this helper's cell inspection limit.")
                        address = element.get("r")
                        if not address:
                            raise ValueError("A cell is missing its address.")
                        location = (title, address)
                        formula = element.find(SHEET_NS + "f")
                        value = element.find(SHEET_NS + "v")
                        if formula is not None:
                            if EXTERNAL_FUNCTION.search(formula.text or ""):
                                raise ValueError("Formulas calling external services are unsupported.")
                            formulas.add(location)
                            if len(formulas) > 200_000:
                                raise ValueError("Workbook exceeds this helper's formula inspection limit.")
                            if value is None or (value.text is None and element.get("t") != "str"):
                                missing_count += 1
                                if len(missing) < 20:
                                    missing.append(f"{title}!{address}")
                        if element.get("t") == "e":
                            error_count += 1
                            if len(errors) < 20:
                                errors.append({"cell": f"{title}!{address}", "value": None if value is None else value.text})
                        element.clear()
                    elif element.tag == SHEET_NS + "row" and sheet_data is not None:
                        sheet_data.clear()
    return {"sheets": sheets, "formula_locations": formulas, "formula_count": len(formulas),
            "error_count": error_count, "errors": errors,
            "missing_cache_count": missing_count, "missing_caches": missing}


def digest(file):
    result = hashlib.sha256()
    with open(file, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def recalculate(source, output, timeout=60, executable=None):
    source, output = Path(source).resolve(), Path(output).resolve()
    if source.suffix.lower() != ".xlsx" or output.suffix.lower() != ".xlsx":
        raise ValueError("Both paths must be .xlsx files; macros are not supported.")
    if source == output or output.exists():
        raise ValueError("Use a new output path; existing files will not be overwritten.")
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("Timeout must be a positive finite number.")
    original_hash = digest(source)
    before = scan_workbook(source)
    # Keep the temporary output on the destination filesystem and source untouched.
    with tempfile.TemporaryDirectory(prefix="cardbush-xlsx-", dir=output.parent) as scratch:
        scratch = Path(scratch)
        inputs, converted = scratch / "input", scratch / "converted"
        inputs.mkdir()
        converted.mkdir()
        copied = inputs / "workbook.xlsx"
        shutil.copyfile(source, copied)
        if digest(copied) != original_hash:
            raise ValueError("Source changed during copying; no output was published.")
        if before["formula_count"]:
            engine = find_soffice(executable)
            result = subprocess.run([engine, "-env:UserInstallation=" + (scratch / "profile").as_uri(),
                                     "--headless", "--convert-to", "xlsx:Calc MS Excel 2007 XML",
                                     "--outdir", str(converted), str(copied)],
                                    capture_output=True, text=True, encoding="utf-8", errors="replace",
                                    timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            if result.returncode:
                raise RuntimeError(f"LibreOffice exited with code {result.returncode}: {result.stderr[-1000:]}")
            candidate = converted / copied.name
            if not candidate.is_file():
                raise RuntimeError("LibreOffice did not produce a new workbook.")
        else:
            candidate = copied
        after = scan_workbook(candidate)
        if before["sheets"] != after["sheets"] or before["formula_locations"] != after["formula_locations"]:
            raise RuntimeError("Worksheet names/order or formula locations changed; inspect manually.")
        if after["error_count"] or after["missing_cache_count"]:
            raise RuntimeError("Output has error cells or missing formula caches: " + json.dumps(
                {key: value for key, value in after.items() if key != "formula_locations"}, ensure_ascii=False))
        if digest(source) != original_hash:
            raise RuntimeError("Source changed during conversion; no output was published.")
        # Exclusive creation also protects an output created after the initial check.
        with output.open("xb") as destination:
            try:
                with candidate.open("rb") as stream:
                    shutil.copyfileobj(stream, destination)
            except BaseException:
                destination.close()
                output.unlink(missing_ok=True)
                raise
        return {"status": "success" if before["formula_count"] else "not_needed",
                "output": str(output), "source_modified": False,
                "formula_count": after["formula_count"], "error_count": 0, "missing_cache_count": 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", nargs="?")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--soffice")
    parser.add_argument("--check-dependencies", action="store_true")
    args = parser.parse_args()
    try:
        if args.check_dependencies:
            result = {"ready": True, "soffice": find_soffice(args.soffice)}
        else:
            if not args.source or not args.output:
                parser.error("source and output are required unless --check-dependencies is used")
            result = recalculate(args.source, args.output, args.timeout, args.soffice)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, ET.ParseError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(json.dumps({"status": "error", "ready": False, "message": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
