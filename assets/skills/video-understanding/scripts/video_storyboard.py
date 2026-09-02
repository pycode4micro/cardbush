#!/usr/bin/env python3
"""Create timestamped contact sheets for image-based video inspection."""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import math
import platform
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence


SCHEMA = "cardbush.video_storyboard.v1"


@dataclass(frozen=True)
class VideoMetadata:
    duration_seconds: float
    fps: float
    frame_count: int
    width: int
    height: int
    codec: str


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Generate timestamped video contact sheets for an image-capable model. "
            "The source video is never modified."
        ),
    )
    parser.add_argument("video", nargs="?", help="Path to a local video file")
    parser.add_argument(
        "--output-dir",
        help="Parent scratch directory; a unique run directory is created inside it",
    )
    parser.add_argument(
        "--mode",
        choices=("uniform", "scenes", "sequence"),
        default="uniform",
        help="Sampling strategy (default: uniform)",
    )
    parser.add_argument("--start", default="0", help="Start time in seconds or HH:MM:SS.mmm")
    parser.add_argument("--end", help="End time in seconds or HH:MM:SS.mmm")
    parser.add_argument("--frames", type=int, default=16, help="Total samples, 1-120")
    parser.add_argument(
        "--step",
        type=float,
        default=0.5,
        help="Seconds between sequence samples (default: 0.5)",
    )
    parser.add_argument(
        "--sheet-size",
        type=int,
        default=16,
        help="Frames per contact sheet, 4-20 (default: 16)",
    )
    parser.add_argument("--columns", type=int, default=4, help="Contact-sheet columns, 2-5")
    parser.add_argument(
        "--tile-width",
        type=int,
        default=360,
        help="Width of each contact-sheet cell, 200-640 pixels",
    )
    parser.add_argument(
        "--scene-threshold",
        type=float,
        default=0.16,
        help="Normalized visual-change threshold for scenes mode, 0-1",
    )
    parser.add_argument(
        "--scene-scan-limit",
        type=int,
        default=600,
        help="Maximum approximate probes for scenes mode, 100-5000",
    )
    parser.add_argument(
        "--keep-frames",
        action="store_true",
        help="Retain sampled full frames in addition to contact sheets",
    )
    parser.add_argument(
        "--full-frame-max-width",
        type=int,
        default=1600,
        help="Maximum retained-frame width, 640-3840 pixels",
    )
    parser.add_argument("--jpeg-quality", type=int, default=90, help="JPEG quality, 70-95")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print the JSON manifest")
    parser.add_argument(
        "--check-dependencies",
        action="store_true",
        help="Report decoder/compositor availability as JSON and exit",
    )
    return parser


def dependency_report() -> dict[str, Any]:
    probes = {
        "opencv": "cv2",
        "numpy": "numpy",
        "pillow": "PIL.Image",
    }
    modules: dict[str, bool] = {}
    errors: dict[str, str] = {}
    for label, module_name in probes.items():
        try:
            spec = importlib.util.find_spec(module_name)
        except (ImportError, ModuleNotFoundError, AttributeError) as error:
            spec = None
            errors[label] = f"{type(error).__name__}: {error}"
        if spec is None:
            modules[label] = False
            errors.setdefault(label, "module not found")
            continue
        try:
            importlib.import_module(module_name)
            modules[label] = True
        except Exception as error:  # A present native module can still fail to load.
            modules[label] = False
            errors[label] = f"{type(error).__name__}: {error}"
    return {
        "schema": SCHEMA,
        "operation": "dependency_check",
        "ready": all(modules.values()),
        "python": platform.python_version(),
        "modules": modules,
        "missing": [name for name, available in modules.items() if not available],
        **({"errors": errors} if errors else {}),
    }


def load_media_modules() -> tuple[Any, Any, Any, Any]:
    report = dependency_report()
    if not report["ready"]:
        missing = ", ".join(report["missing"])
        raise RuntimeError(
            f"Missing video storyboard dependencies: {missing}. "
            "Use an authorized Python environment with opencv-python and Pillow."
        )
    cv2 = importlib.import_module("cv2")
    np = importlib.import_module("numpy")
    Image = importlib.import_module("PIL.Image")
    ImageDraw = importlib.import_module("PIL.ImageDraw")
    return cv2, np, Image, ImageDraw


def parse_time(value: str, label: str) -> float:
    raw = value.strip()
    if not raw:
        raise ValueError(f"{label} cannot be empty")
    try:
        seconds = float(raw)
    except ValueError:
        parts = raw.split(":")
        if len(parts) not in (2, 3):
            raise ValueError(f"{label} must be seconds, MM:SS, or HH:MM:SS.mmm") from None
        try:
            numeric = [float(part) for part in parts]
        except ValueError:
            raise ValueError(f"{label} contains an invalid time value") from None
        if any(part < 0 for part in numeric) or numeric[-1] >= 60 or (
            len(numeric) == 3 and numeric[-2] >= 60
        ):
            raise ValueError(f"{label} contains an out-of-range time value")
        seconds = numeric[-1] + 60 * numeric[-2]
        if len(numeric) == 3:
            seconds += 3600 * numeric[0]
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError(f"{label} must be a finite non-negative time")
    return seconds


def format_time(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def bounded(value: int | float, minimum: int | float, maximum: int | float, label: str):
    if value < minimum or value > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return value


def open_video(cv2: Any, source: Path) -> tuple[Any, VideoMetadata]:
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open the video: {source}")
    if hasattr(cv2, "CAP_PROP_ORIENTATION_AUTO"):
        capture.set(cv2.CAP_PROP_ORIENTATION_AUTO, 1)
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    if not math.isfinite(fps) or fps <= 0 or frame_count <= 0:
        capture.release()
        raise RuntimeError(
            "The decoder did not expose reliable FPS/frame-count metadata; "
            "transcode the video to a standard MP4 or use another authorized decoder."
        )
    duration = frame_count / fps
    codec_value = int(capture.get(cv2.CAP_PROP_FOURCC) or 0)
    codec = "".join(chr((codec_value >> (8 * index)) & 0xFF) for index in range(4)).strip("\x00 ")
    return capture, VideoMetadata(
        duration_seconds=duration,
        fps=fps,
        frame_count=frame_count,
        width=width,
        height=height,
        codec=codec,
    )


def normalize_range(
    start: float,
    end: float | None,
    metadata: VideoMetadata,
) -> tuple[float, float, list[str]]:
    warnings: list[str] = []
    frame_duration = 1 / metadata.fps
    last_seek = max(0.0, metadata.duration_seconds - frame_duration)
    if start > last_seek + frame_duration / 2:
        raise ValueError(
            f"start ({format_time(start)}) is outside the video duration "
            f"({format_time(metadata.duration_seconds)})"
        )
    requested_end = metadata.duration_seconds if end is None else end
    if requested_end > metadata.duration_seconds:
        warnings.append("Requested end exceeded the video duration and was clamped.")
    effective_end = min(requested_end, last_seek)
    effective_start = min(start, last_seek)
    if effective_end < effective_start:
        raise ValueError("end must be greater than or equal to start")
    return effective_start, effective_end, warnings


def uniform_timestamps(start: float, end: float, count: int) -> list[float]:
    if count == 1 or math.isclose(start, end):
        return [start]
    return [start + (end - start) * index / (count - 1) for index in range(count)]


def sequence_timestamps(start: float, end: float, count: int, step: float) -> list[float]:
    values = []
    for index in range(count):
        timestamp = start + index * step
        if timestamp > end + 1e-9:
            break
        values.append(timestamp)
    return values or [start]


def read_frame(capture: Any, cv2: Any, timestamp: float, frame_duration: float) -> tuple[Any, int]:
    attempts = [timestamp, max(0.0, timestamp - frame_duration), max(0.0, timestamp - 3 * frame_duration)]
    for candidate in attempts:
        capture.set(cv2.CAP_PROP_POS_MSEC, candidate * 1000)
        ok, frame = capture.read()
        if ok and frame is not None:
            frame_index = max(0, int(capture.get(cv2.CAP_PROP_POS_FRAMES) or 1) - 1)
            return frame, frame_index
    raise RuntimeError(f"Unable to decode a frame near {format_time(timestamp)}")


def scene_timestamps(
    capture: Any,
    cv2: Any,
    np: Any,
    start: float,
    end: float,
    count: int,
    threshold: float,
    scan_limit: int,
    frame_duration: float,
) -> tuple[list[float], int, int]:
    span = max(0.0, end - start)
    if count == 1 or span <= frame_duration:
        return [start], 0, 0
    scan_step = max(frame_duration, span / max(2, scan_limit - 1))
    probes = max(2, min(scan_limit, math.floor(span / scan_step) + 1))
    candidates: list[tuple[float, float]] = []
    previous = None
    for timestamp in uniform_timestamps(start, end, probes):
        try:
            frame, _ = read_frame(capture, cv2, timestamp, frame_duration)
        except RuntimeError:
            continue
        height, width = frame.shape[:2]
        target_width = 160
        target_height = max(1, round(height * target_width / max(1, width)))
        gray = cv2.cvtColor(
            cv2.resize(frame, (target_width, target_height), interpolation=cv2.INTER_AREA),
            cv2.COLOR_BGR2GRAY,
        )
        if previous is not None:
            score = float(np.mean(cv2.absdiff(gray, previous)) / 255.0)
            if score >= threshold:
                candidates.append((score, timestamp))
        previous = gray

    minimum_gap = max(frame_duration * 2, span / max(3, count * 3))
    selected = [start]
    if not math.isclose(start, end):
        selected.append(end)
    for _, timestamp in sorted(candidates, reverse=True):
        if all(abs(timestamp - existing) >= minimum_gap for existing in selected):
            selected.append(timestamp)
        if len(selected) >= count:
            break
    detected_count = max(0, len(selected) - (1 if math.isclose(start, end) else 2))
    before_supplement = len(selected)
    if before_supplement < count:
        for timestamp in uniform_timestamps(start, end, count):
            if all(abs(timestamp - existing) >= frame_duration / 2 for existing in selected):
                selected.append(timestamp)
            if len(selected) >= count:
                break
    supplemented_count = max(0, min(count, len(selected)) - before_supplement)
    return sorted(selected[:count]), detected_count, supplemented_count


def resize_contained(image: Any, Image: Any, width: int, height: int) -> Any:
    scale = min(width / image.width, height / image.height)
    resized = image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGB", (width, height), "#101210")
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def compose_sheet(
    Image: Any,
    ImageDraw: Any,
    frames: Sequence[tuple[int, float, Any]],
    columns: int,
    tile_width: int,
    sheet_number: int,
    total_sheets: int,
    mode: str,
    destination: Path,
    quality: int,
) -> None:
    if not frames:
        raise RuntimeError("Cannot compose an empty contact sheet")
    first_image = frames[0][2]
    aspect_height = round(tile_width * first_image.height / max(1, first_image.width))
    tile_height = max(140, min(round(tile_width * 1.5), aspect_height))
    label_height = 28
    header_height = 42
    gap = 8
    margin = 12
    rows = math.ceil(len(frames) / columns)
    canvas_width = margin * 2 + columns * tile_width + (columns - 1) * gap
    canvas_height = margin * 2 + header_height + rows * (tile_height + label_height) + (rows - 1) * gap
    canvas = Image.new("RGB", (canvas_width, canvas_height), "#181a18")
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (margin, margin),
        f"VIDEO STORYBOARD | {mode.upper()} | SHEET {sheet_number}/{total_sheets}",
        fill="#f1f3ef",
    )
    for cell, (index, timestamp, image) in enumerate(frames):
        row, column = divmod(cell, columns)
        left = margin + column * (tile_width + gap)
        top = margin + header_height + row * (tile_height + label_height + gap)
        tile = resize_contained(image, Image, tile_width, tile_height)
        canvas.paste(tile, (left, top))
        draw.rectangle(
            (left, top + tile_height, left + tile_width, top + tile_height + label_height),
            fill="#252825",
        )
        draw.text(
            (left + 8, top + tile_height + 7),
            f"#{index:03d}  {format_time(timestamp)}",
            fill="#f1f3ef",
        )
    canvas.save(destination, format="JPEG", quality=quality, optimize=True)


def retained_frame(image: Any, Image: Any, max_width: int) -> Any:
    if image.width <= max_width:
        return image
    height = max(1, round(image.height * max_width / image.width))
    return image.resize((max_width, height), Image.Resampling.LANCZOS)


def make_run_directory(parent: Path) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run = parent / f"video-storyboard-{stamp}-{uuid.uuid4().hex[:8]}"
    run.mkdir(parents=False, exist_ok=False)
    return run


def manifest_json(payload: dict[str, Any], pretty: bool, *, ascii_safe: bool = False) -> str:
    return json.dumps(payload, ensure_ascii=ascii_safe, indent=2 if pretty else None)


def run(args: argparse.Namespace) -> dict[str, Any]:
    if not args.video:
        raise ValueError("video is required unless --check-dependencies is used")
    if not args.output_dir:
        raise ValueError("--output-dir is required")
    bounded(args.frames, 1, 120, "--frames")
    bounded(args.sheet_size, 4, 20, "--sheet-size")
    bounded(args.columns, 2, 5, "--columns")
    bounded(args.tile_width, 200, 640, "--tile-width")
    bounded(args.scene_threshold, 0, 1, "--scene-threshold")
    bounded(args.scene_scan_limit, 100, 5000, "--scene-scan-limit")
    bounded(args.full_frame_max_width, 640, 3840, "--full-frame-max-width")
    bounded(args.jpeg_quality, 70, 95, "--jpeg-quality")
    if not math.isfinite(args.step) or args.step <= 0:
        raise ValueError("--step must be a finite positive number")

    source_candidate = Path(args.video).expanduser()
    if not source_candidate.exists():
        raise ValueError(f"video does not exist: {source_candidate}")
    source = source_candidate.resolve()
    if not source.is_file():
        raise ValueError(f"video is not a file: {source}")
    output_parent = Path(args.output_dir).expanduser().resolve()
    cv2, np, Image, ImageDraw = load_media_modules()
    capture, metadata = open_video(cv2, source)
    try:
        start = parse_time(args.start, "--start")
        requested_end = parse_time(args.end, "--end") if args.end is not None else None
        start, end, warnings = normalize_range(start, requested_end, metadata)
        frame_duration = 1 / metadata.fps
        detected_scenes = None
        uniform_supplements = None
        if args.mode == "sequence":
            timestamps = sequence_timestamps(start, end, args.frames, args.step)
            if len(timestamps) < args.frames:
                warnings.append("Sequence reached the selected range before the requested frame count.")
        elif args.mode == "scenes":
            timestamps, detected_scenes, uniform_supplements = scene_timestamps(
                capture,
                cv2,
                np,
                start,
                end,
                args.frames,
                args.scene_threshold,
                args.scene_scan_limit,
                frame_duration,
            )
            if uniform_supplements > 0:
                warnings.append(
                    "Scene candidates were supplemented with uniform samples to preserve coverage."
                )
        else:
            timestamps = uniform_timestamps(start, end, args.frames)

        run_directory = make_run_directory(output_parent)
        sheet_count = math.ceil(len(timestamps) / args.sheet_size)
        frame_records: list[dict[str, Any]] = []
        sheet_records: list[dict[str, Any]] = []
        for sheet_index in range(sheet_count):
            chunk = timestamps[
                sheet_index * args.sheet_size : (sheet_index + 1) * args.sheet_size
            ]
            decoded: list[tuple[int, float, Any]] = []
            first_record_index = len(frame_records)
            for timestamp in chunk:
                display_index = len(frame_records) + 1
                frame, source_frame_index = read_frame(capture, cv2, timestamp, frame_duration)
                image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                frame_path = None
                if args.keep_frames:
                    frame_path = run_directory / (
                        f"frame-{display_index:03d}-{format_time(timestamp).replace(':', '-')}.jpg"
                    )
                    retained_frame(image, Image, args.full_frame_max_width).save(
                        frame_path,
                        format="JPEG",
                        quality=args.jpeg_quality,
                        optimize=True,
                    )
                decoded.append((display_index, timestamp, image))
                frame_records.append({
                    "index": display_index,
                    "timestamp_seconds": round(timestamp, 6),
                    "timestamp": format_time(timestamp),
                    "source_frame_index": source_frame_index,
                    "sheet": sheet_index + 1,
                    "cell": len(decoded),
                    **({"path": str(frame_path)} if frame_path else {}),
                })
            sheet_path = run_directory / f"contact-sheet-{sheet_index + 1:02d}.jpg"
            compose_sheet(
                Image,
                ImageDraw,
                decoded,
                args.columns,
                args.tile_width,
                sheet_index + 1,
                sheet_count,
                args.mode,
                sheet_path,
                args.jpeg_quality,
            )
            records = frame_records[first_record_index:]
            sheet_records.append({
                "sheet": sheet_index + 1,
                "path": str(sheet_path),
                "frame_indices": [record["index"] for record in records],
                "start": records[0]["timestamp"],
                "end": records[-1]["timestamp"],
            })

        payload: dict[str, Any] = {
            "schema": SCHEMA,
            "source": str(source),
            "run_directory": str(run_directory),
            "mode": args.mode,
            "metadata": {
                "duration_seconds": round(metadata.duration_seconds, 6),
                "duration": format_time(metadata.duration_seconds),
                "fps": round(metadata.fps, 6),
                "frame_count": metadata.frame_count,
                "width": metadata.width,
                "height": metadata.height,
                "codec": metadata.codec,
            },
            "range": {
                "start_seconds": round(start, 6),
                "end_seconds": round(end, 6),
                "start": format_time(start),
                "end": format_time(end),
            },
            "requested_frames": args.frames,
            "sampled_frames": len(frame_records),
            "contact_sheets": sheet_records,
            "frames": frame_records,
            "warnings": warnings + [
                "Timestamps are decoder seek targets and may resolve to a nearby encoded frame.",
                "This storyboard contains visual evidence only; audio was not analyzed.",
            ],
        }
        if detected_scenes is not None:
            payload["detected_scene_candidates_used"] = detected_scenes
            payload["uniform_supplements"] = uniform_supplements
        manifest_path = run_directory / "manifest.json"
        payload["manifest_path"] = str(manifest_path)
        manifest_path.write_text(manifest_json(payload, True) + "\n", encoding="utf-8")
        return payload
    finally:
        capture.release()


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.check_dependencies:
        print(manifest_json(dependency_report(), args.pretty, ascii_safe=True))
        return 0
    try:
        payload = run(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(manifest_json({
            "schema": SCHEMA,
            "error": {
                "code": "video_storyboard_failed",
                "message": str(error),
            },
        }, False, ascii_safe=True), file=sys.stderr)
        return 2
    # ASCII-safe JSON survives Windows shell/code-page boundaries. The persisted
    # manifest remains normal UTF-8 with readable local paths.
    print(manifest_json(payload, args.pretty, ascii_safe=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
