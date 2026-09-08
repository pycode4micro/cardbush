"""Recalculate XLSX formulas in isolation; publish only verified results.

Uses the standard library for streaming OOXML validation. LibreOffice is needed
only for calculation, never assumed to be installed. It may normalize Excel
formatting/features; this is not an Excel compatibility certification.
"""

import argparse
import hashlib
import json
import math
import os
import posixpath
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

from office.soffice import find_soffice, run_soffice


def _tag(element):
    return element.tag.rsplit("}", 1)[-1]


def _record(summary, key, location):
    entry = summary.setdefault(key, {"count": 0, "locations": []})
    entry["count"] += 1
    if len(entry["locations"]) < 20:
        entry["locations"].append(location)


def scan_workbook(filename):
    """Read populated cells once, without loading sheets or shared strings."""
    report = {
        "total_formulas": 0, "total_errors": 0, "error_summary": {},
        "missing_formula_caches": {"count": 0, "locations": []},
        "warnings": [], "_formula_layout": {}, "_has_macros": False,
    }
    with zipfile.ZipFile(filename) as archive:
        names = set(archive.namelist())
        report["_has_macros"] = any(name.lower().endswith("vbaproject.bin") for name in names)
        if any(name.startswith("xl/externalLinks/") for name in names):
            report["warnings"].append("External workbook links are not refreshed; their cached source data may be stale.")
        with archive.open("xl/_rels/workbook.xml.rels") as stream:
            relationships = {}
            for rel in ET.parse(stream).getroot():
                if rel.get("TargetMode") == "External":
                    continue
                target = rel.get("Target", "").replace("\\", "/")
                relationships[rel.get("Id")] = (
                    target.lstrip("/") if target.startswith("/")
                    else posixpath.normpath(posixpath.join("xl", target))
                )
        with archive.open("xl/workbook.xml") as stream:
            sheets = [element for element in ET.parse(stream).getroot().iter() if _tag(element) == "sheet"]
        for sheet in sheets:
            sheet_name = sheet.get("name", "")
            relation_id = next((value for key, value in sheet.attrib.items() if key.endswith("}id")), None)
            part = relationships.get(relation_id)
            if not part or part not in names:
                raise ValueError(f"Missing worksheet part for {sheet_name}")
            count, layout = 0, hashlib.sha256()
            with archive.open(part) as stream:
                stack = []
                for event, cell in ET.iterparse(stream, events=("start", "end")):
                    if event == "start":
                        stack.append(cell)
                        continue
                    if _tag(cell) == "c":
                        children = {_tag(child): child for child in cell}
                        value = children.get("v")
                        location = f"{sheet_name}!{cell.get('r', '?')}"
                        if cell.get("t") == "e":
                            _record(report["error_summary"], value.text if value is not None and value.text else "unknown_error", location)
                            report["total_errors"] += 1
                        if "f" in children:
                            count += 1
                            layout.update((cell.get("r", "?") + "\n").encode("utf-8"))
                            # A formula returning "" has t="str" and an empty v;
                            # openpyxl's uncalculated numeric <v/> is not a cache.
                            if value is None or (value.text is None and cell.get("t") != "str"):
                                missing = report["missing_formula_caches"]
                                missing["count"] += 1
                                if len(missing["locations"]) < 20:
                                    missing["locations"].append(location)
                    # Retain f/v until their parent cell is inspected. Removing
                    # processed nodes also bounds memory for very sparse sheets.
                    if len(stack) > 1 and _tag(stack[-2]) != "c":
                        stack[-2].remove(cell)
                    stack.pop()
            report["total_formulas"] += count
            report["_formula_layout"][sheet_name] = (count, layout.hexdigest())
    return report


def _public(report):
    return {key: value for key, value in report.items() if not key.startswith("_")}


def _fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _basic_string(value):
    return '"' + str(value).replace('"', '""') + '"'


def _write_profile(profile, workbook, receipt):
    """Install only our application macro, never touch the user's LO profile."""
    basic = profile / "user" / "basic"
    standard = basic / "Standard"
    standard.mkdir(parents=True)
    (basic / "script.xlc").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<library:libraries xmlns:library="http://openoffice.org/2000/library" xmlns:xlink="http://www.w3.org/1999/xlink">
 <library:library library:name="Standard" xlink:href="$(USER)/basic/Standard/script.xlb/" xlink:type="simple" library:link="false"/>
</library:libraries>''', encoding="utf-8")
    (standard / "script.xlb").write_text('''<?xml version="1.0" encoding="UTF-8"?>
<library:library xmlns:library="http://openoffice.org/2000/library" library:name="Standard" library:readonly="false" library:passwordprotected="false">
 <library:element library:name="Recalc"/>
</library:library>''', encoding="utf-8")
    # NEVER_EXECUTE=0, NO_UPDATE=0 per the UNO document constants. These apply
    # to the opened workbook; the trusted application macro is in this profile.
    source = f'''Sub RecalculateAndSave
  Dim doc As Object, properties(2) As New com.sun.star.beans.PropertyValue
  Dim handle As Integer, message As String
  On Error GoTo Failed
  properties(0).Name = "Hidden"
  properties(0).Value = True
  properties(1).Name = "MacroExecutionMode"
  properties(1).Value = 0
  properties(2).Name = "UpdateDocMode"
  properties(2).Value = 0
  doc = StarDesktop.loadComponentFromURL({_basic_string(workbook.as_uri())}, "_blank", 0, properties())
  doc.calculateAll()
  doc.store()
  doc.close(True)
  message = "ok"
  GoTo Finish
Failed:
  message = "error: " & Error$
  On Error Resume Next
  doc.close(True)
Finish:
  handle = FreeFile
  Open {_basic_string(receipt)} For Output As #handle
  Print #handle, message
  Close #handle
  StarDesktop.terminate()
End Sub'''
    (standard / "Recalc.xba").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<script:module xmlns:script="http://openoffice.org/2000/script" '
        'script:name="Recalc" script:language="StarBasic">'
        + escape(source) + '</script:module>', encoding="utf-8",
    )


def recalc(filename, timeout=30, soffice=None):
    path = Path(filename).resolve()
    failure = {"modified": False}
    if not math.isfinite(timeout) or timeout <= 0:
        return {**failure, "status": "error", "error": "timeout must be a positive finite number"}
    if path.suffix.lower() != ".xlsx":
        return {**failure, "status": "unsupported", "error": "Automatic recalculation supports .xlsx only; use Excel for macro-enabled or other formats."}
    try:
        if not path.is_file():
            raise FileNotFoundError(f"Workbook not found: {path}")
        # Put staging on the same volume for atomic replacement. Calculation
        # failures, missing caches and concurrent edits leave the source intact.
        with tempfile.TemporaryDirectory(prefix=".cardbush-recalc-", dir=path.parent) as directory:
            scratch = Path(directory)
            working = scratch / "workbook.xlsx"
            shutil.copy2(path, working)
            original = _fingerprint(working)
            before = scan_workbook(working)
            if before["_has_macros"]:
                return {**failure, "status": "unsupported", "error": "The workbook contains VBA; use Excel to preserve and verify its behavior."}
            if not before["total_formulas"]:
                return {**failure, **_public(before), "status": "errors_found" if before["total_errors"] else "not_needed"}
            try:
                executable = find_soffice(soffice)
            except FileNotFoundError as error:
                return {**failure, "status": "dependency_missing", "error": str(error)}
            profile, receipt = scratch / "profile", scratch / "receipt.txt"
            _write_profile(profile, working, receipt)
            result = run_soffice([
                f"-env:UserInstallation={profile.as_uri()}",
                "--headless", "--norestore", "--nodefault", "--nofirststartwizard",
                "macro:///Standard.Recalc.RecalculateAndSave",
            ], executable=executable, timeout=timeout, capture_output=True, text=True, errors="replace")
            if result.returncode != 0:
                return {**failure, "status": "error", "error": (result.stderr or f"LibreOffice exited with code {result.returncode}")[-2000:]}
            completed = receipt.read_text(encoding="utf-8", errors="replace").strip() if receipt.is_file() else ""
            if completed != "ok":
                return {**failure, "status": "incomplete", "error": completed or "LibreOffice did not confirm calculation and save completion."}
            after = scan_workbook(working)
            if after["_formula_layout"] != before["_formula_layout"]:
                return {**failure, "status": "incomplete", "error": "Worksheet names or formula locations changed during recalculation."}
            checked = _public(after)
            if after["total_errors"]:
                return {**failure, **checked, "status": "errors_found"}
            if after["missing_formula_caches"]["count"]:
                return {**failure, **checked, "status": "incomplete", "error": "Some formulas still have no cached result."}
            if not path.is_file() or _fingerprint(path) != original:
                return {**failure, "status": "conflict", "error": "The source changed during recalculation; it was not overwritten."}
            os.replace(working, path)
            # A subsequent temporary-directory cleanup failure must not claim
            # that the already-published workbook remained unchanged.
            failure["modified"] = True
            return {**checked, "status": "success", "modified": True}
    except subprocess.TimeoutExpired:
        return {**failure, "status": "timeout", "error": f"LibreOffice exceeded {timeout:g} seconds; calculation was not verified."}
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, ET.ParseError, subprocess.SubprocessError) as error:
        return {**failure, "status": "error", "error": str(error)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("filename", nargs="?")
    parser.add_argument("timeout", nargs="?", type=float, default=30)
    parser.add_argument("--soffice", help="LibreOffice executable path (also supports SOFFICE_PATH)")
    parser.add_argument("--check-dependencies", action="store_true")
    args = parser.parse_args()
    if args.check_dependencies:
        try:
            result = {"ready": True, "soffice": find_soffice(args.soffice)}
        except FileNotFoundError as error:
            result = {"ready": False, "status": "dependency_missing", "error": str(error)}
        code = 0 if result["ready"] else 1
    else:
        if not args.filename:
            parser.error("filename is required unless --check-dependencies is used")
        result = recalc(args.filename, args.timeout, args.soffice)
        code = 0 if result["status"] in ("success", "not_needed") else 1
    print(json.dumps(result, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
