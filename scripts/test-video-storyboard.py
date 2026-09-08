"""Duration-aware video coverage tests, including real local video decoding."""

import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "assets/skills/video-understanding/scripts/video_storyboard.py"
spec = importlib.util.spec_from_file_location("video_storyboard", SCRIPT)
storyboard = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = storyboard
spec.loader.exec_module(storyboard)


def arguments(*values):
    return storyboard.build_parser().parse_args(list(values))


def metadata(count=5, fps=30):
    return storyboard.VideoMetadata(count / fps, fps, count, 128, 72, "TEST")


class SequentialCapture:
    def __init__(self, timestamps):
        self.timestamps = timestamps
        self.position = 0

    def read(self):
        if self.position == len(self.timestamps):
            return False, None
        self.position += 1
        return True, object()

    def get(self, _):
        return self.timestamps[self.position - 1] * 1000

    def set(self, *_):
        raise AssertionError("All-frame coverage must not seek")


class FakeCV:
    CAP_PROP_POS_MSEC = 0


class PlanningAndCoverageTests(unittest.TestCase):
    def test_auto_density_tracks_duration_and_source_fps(self):
        args = arguments()
        self.assertEqual(args.mode, "auto")
        for duration in [0, 1, 60, 120]:
            plan = storyboard.sampling_plan(args, duration, 120)
            self.assertEqual(plan["strategy"], "all", duration)
        for duration, step in [(120.01, 0.5), (600, 0.5), (600.01, 1), (1800, 1), (1800.01, 5)]:
            plan = storyboard.sampling_plan(args, duration, 30)
            self.assertEqual((plan["strategy"], plan["interval_seconds"]), ("interval", step))
        self.assertEqual(storyboard.sampling_plan(args, 300, 1)["interval_seconds"], 1)

    def test_explicit_controls_are_respected_without_silent_frame_caps(self):
        self.assertEqual(storyboard.sampling_plan(arguments("--mode", "all"), 7200, 60)["strategy"], "all")
        self.assertEqual(storyboard.sampling_plan(arguments("--short-video-seconds", "180"), 150, 30)["strategy"], "all")
        self.assertEqual(storyboard.sampling_plan(arguments("--frames", "8"), 3, 30)["strategy"], "uniform")
        self.assertEqual(storyboard.sampling_plan(arguments("--step", "0.2"), 3, 30)["interval_seconds"], 0.2)
        for flags in [("--frames", "8"), ("--step", "0.2")]:
            with self.assertRaises(ValueError):
                storyboard.sampling_plan(arguments("--mode", "all", *flags), 3, 30)

    def test_every_frame_uses_sequential_decode_and_varying_decoder_timestamps(self):
        times = [0, 0.016, 0.049, 0.18, 0.42]
        coverage, warnings = {}, []
        frames = list(storyboard.sequential_frames(SequentialCapture(times), FakeCV, metadata(), 0, None, coverage, warnings))
        self.assertEqual([frame.source_frame_index for frame in frames], list(range(5)))
        self.assertEqual([frame.timestamp for frame in frames], times)
        self.assertTrue(all(frame.timestamp_source == "decoder" for frame in frames))
        self.assertTrue(coverage["decode_complete"])
        self.assertTrue(coverage["reached_eof"])

    def test_early_decoder_stop_is_not_reported_as_complete(self):
        coverage, warnings = {}, []
        frames = list(storyboard.sequential_frames(SequentialCapture([0, 0.033]), FakeCV, metadata(), 0, None, coverage, warnings))
        self.assertEqual(len(frames), 2)
        self.assertFalse(coverage["decode_complete"])
        self.assertFalse(coverage["metadata_frame_count_matches"])
        self.assertTrue(warnings)

    def test_missing_timestamps_are_labelled_as_estimates(self):
        coverage, warnings = {}, []
        frames = list(storyboard.sequential_frames(SequentialCapture([0, 0, float("nan")]), FakeCV, metadata(3, 30), 0, None, coverage, warnings))
        self.assertEqual([frame.timestamp_source for frame in frames], ["decoder", "fps_estimate", "fps_estimate"])
        self.assertEqual(coverage["fps_estimated_timestamps"], 2)
        self.assertAlmostEqual(frames[-1].timestamp, 2 / 30)
        self.assertTrue(warnings)

    def test_time_range_includes_its_boundary_frames(self):
        coverage, warnings = {}, []
        frames = list(storyboard.sequential_frames(SequentialCapture([0, .1, .2, .3, .4, .5]), FakeCV, metadata(6, 10), .2, .4, coverage, warnings))
        self.assertEqual([frame.source_frame_index for frame in frames], [2, 3, 4])
        self.assertTrue(coverage["decode_complete"])
        self.assertFalse(coverage["reached_eof"])

    def test_batches_cover_the_whole_manifest_without_dumping_frame_records(self):
        payload = {"schema": storyboard.SCHEMA, "contact_sheets": [{"sheet": i} for i in range(1, 12)], "frames": [1] * 176, "sampled_frames": 176}
        offset, observed = 0, []
        while offset is not None:
            response = storyboard.manifest_batch(payload, offset, 4)
            self.assertNotIn("frames", response)
            self.assertEqual(response["contact_sheet_count"], 11)
            self.assertLessEqual(len(response["contact_sheets"]), 4)
            observed.extend(item["sheet"] for item in response["contact_sheets"])
            offset = response["next_sheet_offset"]
        self.assertEqual(observed, list(range(1, 12)))
        self.assertIs(storyboard.manifest_batch(payload, 0, 4, True), payload)
        for offset, limit in [(-1, 4), (12, 4), (0, 0), (0, 5)]:
            with self.assertRaises(ValueError):
                storyboard.manifest_batch(payload, offset, limit)


class RealVideoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        report = storyboard.dependency_report()
        if not report["ready"]:
            raise unittest.SkipTest(f"Real video tests need media modules: {report['missing']}")
        cls.cv2, cls.np, cls.Image, _ = storyboard.load_media_modules()
        cls.directory = tempfile.TemporaryDirectory(prefix="cardbush-video-test-")
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name)
        cls.source = cls.root / "短视频 with flash.avi"
        cls.make_video(cls.source, 153, 30, flash=77)
        cls.source_hash = hashlib.sha256(cls.source.read_bytes()).hexdigest()
        cls.full = storyboard.run(arguments(str(cls.source), "--output-dir", str(cls.root / "sheets"), "--tile-width", "200"))

    @classmethod
    def make_video(cls, path, count, fps, flash=None, size=(128, 72)):
        writer = cls.cv2.VideoWriter(str(path), cls.cv2.VideoWriter_fourcc(*"MJPG"), fps, size)
        if not writer.isOpened():
            raise AssertionError("OpenCV MJPEG test encoder could not open")
        try:
            for index in range(count):
                frame = cls.np.zeros((size[1], size[0], 3), dtype=cls.np.uint8)
                frame[:] = (255, 0, 255) if index == flash else (30, 30, 30)
                cls.cv2.putText(frame, str(index), (4, 18), cls.cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
                writer.write(frame)
        finally:
            writer.release()

    def test_short_video_preserves_all_frames_including_sheet_boundaries_and_tail(self):
        payload = self.full
        self.assertEqual(payload["sampling"]["strategy"], "all")
        self.assertEqual(payload["sampled_frames"], 153, "must exceed the previous 120-frame cap")
        self.assertEqual([frame["source_frame_index"] for frame in payload["frames"]], list(range(153)))
        self.assertEqual(len(payload["contact_sheets"]), 10)
        indices = [index for sheet in payload["contact_sheets"] for index in sheet["frame_indices"]]
        self.assertEqual(indices, list(range(1, 154)))
        self.assertTrue(payload["coverage"]["decode_complete"])
        self.assertEqual(payload["contact_sheets"][-1]["source_frame_end"], 152)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source_hash)
        self.assertFalse(list(Path(payload["run_directory"]).glob("frame-*.jpg")))
        for sheet in payload["contact_sheets"]:
            with self.Image.open(sheet["path"]) as image:
                image.verify()

    def test_single_frame_flash_reaches_the_actual_contact_sheet_pixels(self):
        frame = self.full["frames"][77]
        sheet = self.full["contact_sheets"][frame["sheet"] - 1]
        row, column = divmod(frame["cell"] - 1, 4)
        x = 12 + column * (200 + 8) + 100
        y = 12 + 42 + row * (140 + 28 + 8) + 70
        with self.Image.open(sheet["path"]) as image:
            red, green, blue = image.getpixel((x, y))
        self.assertGreater(red, 220)
        self.assertLess(green, 35)
        self.assertGreater(blue, 220)
        overview = storyboard.run(arguments(str(self.source), "--output-dir", str(self.root / "overview"), "--mode", "uniform", "--frames", "16", "--tile-width", "200"))
        self.assertNotIn(77, [frame["source_frame_index"] for frame in overview["frames"]], "fixture should expose the sparse-overview blind spot")

    def test_selected_interval_uses_all_frames_without_unrelated_images(self):
        payload = storyboard.run(arguments(str(self.source), "--output-dir", str(self.root / "range"), "--start", "2", "--end", "3", "--tile-width", "200", "--keep-frames"))
        self.assertEqual([frame["source_frame_index"] for frame in payload["frames"]], list(range(60, 91)))
        self.assertTrue(all(Path(frame["path"]).is_file() for frame in payload["frames"]))
        self.assertTrue(payload["coverage"]["decode_complete"])

    def test_long_video_samples_across_duration_without_the_120_sample_cap(self):
        source = self.root / "long.avi"
        self.make_video(source, 1000, 8)
        payload = storyboard.run(arguments(str(source), "--output-dir", str(self.root / "long-sheets"), "--tile-width", "200"))
        self.assertEqual(payload["sampling"]["strategy"], "interval")
        self.assertEqual(payload["sampling"]["interval_seconds"], 0.5)
        self.assertEqual(payload["sampled_frames"], 251)
        self.assertEqual(payload["frames"][0]["source_frame_index"], 0)
        self.assertEqual(payload["frames"][-1]["source_frame_index"], 999)
        self.assertFalse(payload["coverage"]["all_decoded_frames_in_range_included"])

    def test_legacy_modes_remain_available(self):
        for mode in ["uniform", "scenes", "sequence"]:
            payload = storyboard.run(arguments(str(self.source), "--output-dir", str(self.root / mode), "--mode", mode, "--frames", "8", "--tile-width", "200"))
            self.assertEqual(payload["sampled_frames"], 8, mode)
            self.assertEqual(payload["sampling"]["strategy"], mode)
            self.assertFalse(payload["coverage"]["all_decoded_frames_in_range_included"])

    def test_portrait_tiles_keep_the_whole_frame(self):
        source = self.root / "portrait.avi"
        self.make_video(source, 7, 30, size=(72, 128))
        payload = storyboard.run(arguments(str(source), "--output-dir", str(self.root / "portrait-sheets"), "--tile-width", "200"))
        self.assertEqual(payload["sampled_frames"], 7)
        with self.Image.open(payload["contact_sheets"][0]["path"]) as image:
            self.assertEqual(image.size, (848, 842))

    def test_cli_batch_loading_does_not_redecode_or_rewrite_the_manifest(self):
        manifest = Path(self.full["manifest_path"])
        original = manifest.read_bytes()
        with patch.object(storyboard, "load_media_modules", side_effect=AssertionError("must not decode again")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = storyboard.main(["--read-manifest", str(manifest), "--sheet-offset", "4"])
        self.assertEqual(code, 0)
        response = json.loads(output.getvalue())
        self.assertEqual([sheet["sheet"] for sheet in response["contact_sheets"]], [5, 6, 7, 8])
        self.assertEqual(response["next_sheet_offset"], 8)
        self.assertNotIn("frames", response)
        self.assertEqual(manifest.read_bytes(), original)

    def test_cli_default_returns_compact_batch_and_full_manifest_on_disk(self):
        process = subprocess.run([sys.executable, "-B", str(SCRIPT), str(self.source), "--output-dir", str(self.root / "cli"), "--tile-width", "200"], capture_output=True, text=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        response = json.loads(process.stdout)
        self.assertEqual(response["sampled_frames"], 153)
        self.assertEqual(len(response["contact_sheets"]), 4)
        self.assertEqual(response["next_sheet_offset"], 4)
        self.assertNotIn("frames", response)
        persisted = json.loads(Path(response["manifest_path"]).read_text(encoding="utf-8"))
        self.assertEqual(len(persisted["frames"]), 153)
        self.assertEqual(len(persisted["contact_sheets"]), 10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
