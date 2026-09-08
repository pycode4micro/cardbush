"""Behavioral regressions for bundled XLSX recalculation, without a model/API."""

import json
import os
import subprocess
import sys
import tempfile
import time
import tracemalloc
import unittest
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "assets/skills/xlsx/scripts"
sys.path.insert(0, str(SCRIPTS))
import recalc
from office import soffice

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
FORMULA = '<c r="B1"><f>A1+1</f><v/></c>'


def workbook(path, cells=FORMULA, extra_parts=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>''')
        archive.writestr("_rels/.rels", f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        archive.writestr("xl/workbook.xml", f'<workbook xmlns="{NS}" xmlns:r="{REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>')
        archive.writestr("xl/_rels/workbook.xml.rels", f'<Relationships xmlns="{PKG}"><Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet xmlns="{NS}"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"><v>1</v></c>{cells}</row></sheetData></worksheet>')
        for name, content in (extra_parts or {}).items():
            archive.writestr(name, content)


def profile_path(args):
    uri = next(arg.split("=", 1)[1] for arg in args if arg.startswith("-env:UserInstallation="))
    value = unquote(urlparse(uri).path)
    return Path(value[1:] if sys.platform == "win32" else value)


class RecalcTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="cardbush-recalc-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "中文 workbook.xlsx"
        workbook(self.path)
        self.original = self.path.read_bytes()

    def run_fake(self, runner):
        with patch.object(recalc, "find_soffice", return_value="test-soffice"), patch.object(recalc, "run_soffice", side_effect=runner):
            result = recalc.recalc(self.path, 0.5)
        self.assertEqual(list(self.path.parent.glob(".cardbush-recalc-*")), [])
        return result

    def assert_preserved(self, result, status):
        self.assertEqual(result["status"], status, result)
        self.assertFalse(result["modified"])
        self.assertEqual(self.path.read_bytes(), self.original)

    def finished(self, args, **kwargs):
        profile = profile_path(args)
        self.assertEqual(profile.parent.parent, self.path.parent)
        self.assertEqual(kwargs["timeout"], 0.5)
        for file in (profile / "user/basic").rglob("*.xl*"):
            ET.parse(file)
        workbook(profile.parent / "workbook.xlsx", '<c r="B1"><f>A1+1</f><v>2</v></c>')
        (profile.parent / "receipt.txt").write_text("ok\n", encoding="utf-8")
        return subprocess.CompletedProcess(args, 0, "", "")

    def test_success_requires_completion_and_populated_caches(self):
        result = self.run_fake(self.finished)
        self.assertEqual(result["status"], "success", result)
        self.assertTrue(result["modified"])
        self.assertEqual(result["total_formulas"], 1)
        self.assertEqual(recalc.scan_workbook(self.path)["missing_formula_caches"]["count"], 0)
        self.assertNotEqual(self.path.read_bytes(), self.original)

    def test_timeout_is_failure_and_preserves_original(self):
        def runner(args, **kwargs):
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])
        self.assert_preserved(self.run_fake(runner), "timeout")

    def test_exit_124_never_means_success(self):
        self.assert_preserved(self.run_fake(lambda args, **kw: subprocess.CompletedProcess(args, 124, "", "")), "error")

    def test_exit_zero_without_receipt_is_incomplete_even_with_old_caches(self):
        workbook(self.path, '<c r="B1"><f>A1+1</f><v>99</v></c>')
        self.original = self.path.read_bytes()
        self.assert_preserved(self.run_fake(lambda args, **kw: subprocess.CompletedProcess(args, 0, "", "")), "incomplete")

    def test_missing_cache_cannot_be_promoted_by_receipt(self):
        def runner(args, **kwargs):
            (profile_path(args).parent / "receipt.txt").write_text("ok\n")
            return subprocess.CompletedProcess(args, 0, "", "")
        result = self.run_fake(runner)
        self.assert_preserved(result, "incomplete")
        self.assertEqual(result["missing_formula_caches"], {"count": 1, "locations": ["Sheet1!B1"]})

    def test_failed_macro_is_incomplete(self):
        def runner(args, **kwargs):
            (profile_path(args).parent / "receipt.txt").write_text("error: cannot store\n")
            return subprocess.CompletedProcess(args, 0, "", "")
        self.assert_preserved(self.run_fake(runner), "incomplete")

    def test_changed_formula_locations_are_not_published(self):
        def runner(args, **kwargs):
            result = self.finished(args, **kwargs)
            workbook(profile_path(args).parent / "workbook.xlsx", '<c r="C1"><f>A1+1</f><v>2</v></c>')
            return result
        self.assert_preserved(self.run_fake(runner), "incomplete")

    def test_errors_are_reported_without_publishing(self):
        def runner(args, **kwargs):
            result = self.finished(args, **kwargs)
            workbook(profile_path(args).parent / "workbook.xlsx", '<c r="B1" t="e"><f>A1/0</f><v>#DIV/0!</v></c>')
            return result
        result = self.run_fake(runner)
        self.assert_preserved(result, "errors_found")
        self.assertEqual(result["error_summary"]["#DIV/0!"], {"count": 1, "locations": ["Sheet1!B1"]})

    def test_concurrent_source_edit_is_preserved(self):
        def runner(args, **kwargs):
            result = self.finished(args, **kwargs)
            self.path.write_bytes(b"new user content")
            return result
        result = self.run_fake(runner)
        self.assertEqual(result["status"], "conflict")
        self.assertEqual(self.path.read_bytes(), b"new user content")

    def test_cleanup_failure_reports_that_publication_already_happened(self):
        real_directory = tempfile.TemporaryDirectory

        class CleanupFailure(real_directory):
            def __exit__(self, *args):
                super().__exit__(*args)
                raise OSError("cleanup failed after publication")

        with patch.object(recalc.tempfile, "TemporaryDirectory", CleanupFailure):
            result = self.run_fake(self.finished)
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["modified"])
        self.assertNotEqual(self.path.read_bytes(), self.original)

    def test_missing_engine_and_invalid_inputs_return_structured_errors(self):
        with patch.object(recalc, "find_soffice", side_effect=FileNotFoundError("unavailable")):
            self.assert_preserved(recalc.recalc(self.path), "dependency_missing")
        self.assertEqual(recalc.recalc(self.path.parent / "missing.xlsx")["status"], "error")
        self.assertEqual(recalc.recalc(self.path.with_suffix(".xlsm"))["status"], "unsupported")
        for timeout in [0, -1, float("inf"), float("nan")]:
            self.assert_preserved(recalc.recalc(self.path, timeout), "error")
        self.path.write_bytes(b"not a zip")
        self.assertEqual(recalc.recalc(self.path)["status"], "error")

    def test_embedded_vba_is_not_roundtripped(self):
        workbook(self.path, extra_parts={"xl/vbaProject.bin": b"macro"})
        self.original = self.path.read_bytes()
        self.assert_preserved(recalc.recalc(self.path), "unsupported")

    def test_literals_empty_string_shared_formulas_and_typed_errors(self):
        workbook(self.path, '''<c r="B1" t="inlineStr"><is><t>Documentation: #REF! means a broken reference</t></is></c>
<c r="C1" t="str"><f>""</f><v/></c>
<c r="D1" t="n"><f t="shared" si="0" ref="D1:E1">A1+1</f><v>2</v></c>
<c r="E1"><f t="shared" si="0"/><v>2</v></c>
<c r="F1" t="e"><v>#SPILL!</v></c>''')
        report = recalc.scan_workbook(self.path)
        self.assertEqual(report["total_formulas"], 3)
        self.assertEqual(report["missing_formula_caches"]["count"], 0)
        self.assertEqual(report["total_errors"], 1)
        self.assertEqual(report["error_summary"]["#SPILL!"]["locations"], ["Sheet1!F1"])

    def test_no_formula_workbook_does_not_require_libreoffice(self):
        workbook(self.path, '<c r="B1" t="inlineStr"><is><t>Reference: #REF!</t></is></c>')
        self.original = self.path.read_bytes()
        with patch.object(recalc, "find_soffice", side_effect=AssertionError("must not launch")):
            self.assert_preserved(recalc.recalc(self.path), "not_needed")

    def test_external_source_limitation_and_bounded_error_samples(self):
        workbook(self.path, ''.join(f'<c r="B{i}" t="e"><f>1/0</f><v>#DIV/0!</v></c>' for i in range(1, 101)), {"xl/externalLinks/externalLink1.xml": "<externalLink/>"})
        report = recalc.scan_workbook(self.path)
        self.assertEqual(report["total_errors"], 100)
        self.assertEqual(report["error_summary"]["#DIV/0!"]["count"], 100)
        self.assertEqual(len(report["error_summary"]["#DIV/0!"]["locations"]), 20)
        self.assertTrue(report["warnings"])

    def test_sparse_dimension_and_many_cells_do_not_create_an_eager_grid(self):
        workbook(self.path, ''.join(f'<c r="B{i}"><f>A1+1</f><v>2</v></c>' for i in range(1, 30001)))
        tracemalloc.start()
        try:
            report = recalc.scan_workbook(self.path)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(report["total_formulas"], 30000)
        self.assertLess(peak, 8 * 1024 * 1024, "scanner retained worksheet cells")

    def test_cli_failure_is_json_with_nonzero_exit(self):
        result = subprocess.run([sys.executable, "-B", str(SCRIPTS / "recalc.py"), str(self.path), "--soffice", str(self.path.parent / "missing-soffice")], capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)["status"], "dependency_missing")

    def test_real_libreoffice_smoke_when_available(self):
        try:
            executable = soffice.find_soffice()
        except FileNotFoundError:
            self.skipTest("LibreOffice unavailable; real calculation smoke not run")
        result = recalc.recalc(self.path, 30, executable)
        self.assertEqual(result["status"], "success", result)
        with zipfile.ZipFile(self.path) as archive:
            sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            value = sheet.find(f".//{{{NS}}}c[@r='B1']/{{{NS}}}v")
            self.assertEqual(float(value.text), 2)


class SofficeTests(unittest.TestCase):
    def test_thumbnail_help_and_dependency_check_work_without_office_packages(self):
        script = ROOT / "assets/skills/pptx/scripts/thumbnail.py"
        help_result = subprocess.run([sys.executable, "-B", str(script), "--help"], capture_output=True, text=True, timeout=10)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("--check-dependencies", help_result.stdout)
        check = subprocess.run([sys.executable, "-B", str(script), "--check-dependencies"], capture_output=True, text=True, timeout=10)
        result = json.loads(check.stdout)
        self.assertEqual(check.returncode, 0 if result["ready"] else 1)
        self.assertEqual(result["ready"], not result["errors"])
        self.assertNotIn("Traceback", check.stderr)

    def test_windows_prefers_console_binary_and_supports_explicit_path(self):
        with patch.object(soffice.sys, "platform", "win32"), patch.dict(os.environ, {"SOFFICE_PATH": ""}), patch.object(soffice.shutil, "which", side_effect=lambda name: f"C:/Office/{name}"):
            self.assertEqual(soffice.find_soffice(), "C:/Office/soffice.com")
            self.assertEqual(soffice.find_soffice("custom"), "C:/Office/custom")

    def test_linux_socket_shim_is_never_enabled_on_windows_or_macos(self):
        for platform in ("win32", "darwin"):
            with patch.object(soffice.sys, "platform", platform), patch.object(soffice, "_needs_shim", side_effect=AssertionError("not a Linux platform")):
                self.assertEqual(soffice.get_soffice_env()["SAL_USE_VCLPLUGIN"], "svp")

    def test_both_skill_bundles_use_the_same_office_runner(self):
        self.assertEqual((SCRIPTS / "office/soffice.py").read_bytes(), (ROOT / "assets/skills/pptx/scripts/office/soffice.py").read_bytes())

    def test_runner_has_a_real_cross_platform_timeout(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            soffice.run_soffice(["-c", "import time; time.sleep(30)"], executable=sys.executable, timeout=0.15, capture_output=True)
        self.assertLess(time.monotonic() - started, 8)
        result = soffice.run_soffice(["-c", "print('done')"], executable=sys.executable, timeout=5, capture_output=True, text=True)
        self.assertEqual(result.stdout.strip(), "done")
        self.assertEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
