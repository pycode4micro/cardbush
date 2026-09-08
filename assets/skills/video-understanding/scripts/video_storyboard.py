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
from typing import Any, Iterable, Sequence


SCHEMA = "cardbush.video_storyboard.v1"
SHORT_VIDEO_SECONDS = 120.0


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
        choices=("auto", "all", "uniform", "scenes", "sequence"),
        default="auto",
        help="Default auto: all frames up to 2 minutes, time-based sampling for longer ranges",
    )
    parser.add_argument("--start", default="0", help="Start time in seconds or HH:MM:SS.mmm")
    parser.add_argument("--end", help="End time in seconds or HH:MM:SS.mmm")
    parser.add_argument("--frames", type=int, help="Manual sample count, 1-120; overrides auto with uniform sampling, incompatible with all")
    parser.add_argument("--short-video-seconds", type=float, default=SHORT_VIDEO_SECONDS,
                        help="Auto mode includes every decoded frame up to this duration (default: 120)")
    parser.add_argument(
        "--step",
        type=float,
        help="Seconds between sequence samples (default: 0.5), or override auto sampling interval",
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
    parser.add_argument("--read-manifest", help="Read an existing manifest's next contact-sheet batch without decoding again")
    parser.add_argument("--sheet-offset", type=int, default=0, help="Zero-based sheet offset in the JSON response (default: 0)")
    parser.add_argument("--sheet-limit", type=int, default=4, help="Sheets listed per JSON response, 1-4 (default: 4)")
    parser.add_argument("--full-manifest", action="store_true", help="Print all sheet and frame records instead of a compact batch")
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
    total_sheets: int | None,
    mode: str,
    destination: Path,
    quality: int,
) -> None:
    if not frames:
        raise RuntimeError("Cannot compose an empty contact sheet")
    columns = min(columns, len(frames))
    first_image = frames[0][2]
    aspect_height = round(tile_width * first_image.height / max(1, first_image.width))
    tile_height = max(140, min(round(tile_width * 2), aspect_height))
    label_height = 28
    header_height = 42
    gap = 8
    margin = 12
    rows = math.ceil(len(frames) / columns)
    canvas_width = margin * 2 + columns * tile_width + (columns - 1) * gap
    canvas_height = margin * 2 + header_height + rows * (tile_height + label_height) + (rows - 1) * gap
    canvas = Image.new("RGB", (canvas_width, canvas_height), "#181a18")
    draw = ImageDraw.Draw(canvas)
    ImageFont = importlib.import_module("PIL.ImageFont")
    try:
        label_font = ImageFont.load_default(size=max(12, min(20, round(tile_width / 20))))
        header_font = ImageFont.load_default(size=18)
    except TypeError:  # Pillow before 10.1 has only the fixed-size default font.
        label_font = header_font = ImageFont.load_default()
    draw.text(
        (margin, margin),
        f"{mode.upper()} | SHEET {sheet_number}"
        + (f"/{total_sheets}" if total_sheets is not None else ""),
        fill="#f1f3ef",
        font=header_font,
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
            (left + 8, top + tile_height + 4),
            f"F{index:05d}  {format_time(timestamp)}",
            fill="#f1f3ef",
            font=label_font,
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


def sampling_plan(args: argparse.Namespace, duration: float, fps: float) -> dict[str, Any]:
    """Choose density from the selected duration; explicit sampling remains available."""
    if args.mode == "all":
        if args.frames is not None or args.step is not None:
            raise ValueError("--mode all cannot be combined with --frames or --step")
        strategy, step = "all", None
    elif args.mode != "auto":
        strategy, step = args.mode, args.step if args.step is not None else 0.5
    elif args.frames is not None:
        if args.step is not None:
            raise ValueError("Use --mode sequence to combine --frames and --step")
        strategy, step = "uniform", None
    elif args.step is not None:
        strategy, step = "interval", max(args.step, 1 / fps)
    elif duration <= args.short_video_seconds + 1e-9:
        strategy, step = "all", None
    else:
        strategy = "interval"
        step = max(0.5 if duration <= 600 else 1.0 if duration <= 1800 else 5.0, 1 / fps)
    return {
        "strategy": strategy,
        "selected_duration_seconds": round(duration, 6),
        "short_video_seconds": args.short_video_seconds,
        "interval_seconds": step if strategy in ("interval", "sequence") else None,
        "manual_frame_count": args.frames,
    }


@dataclass(frozen=True)
class DecodedSample:
    frame: Any
    source_frame_index: int
    timestamp: float
    timestamp_source: str


def sequential_frames(
    capture: Any, cv2: Any, metadata: VideoMetadata, start: float,
    selected_end: float | None, coverage: dict[str, Any], warnings: list[str],
) -> Iterable[DecodedSample]:
    """Read each decoded frame once, in order, without seek, dedupe or a sample cap."""
    decoded_count = 0
    included_count = 0
    previous_timestamp = -1.0
    estimated_timestamps = 0
    end_reached = False
    reached_eof = False
    while True:
        ok, frame = capture.read()
        if not ok or frame is None:
            reached_eof = True
            break
        index = decoded_count
        decoded_count += 1
        reported_timestamp = float(capture.get(cv2.CAP_PROP_POS_MSEC)) / 1000
        if math.isfinite(reported_timestamp) and reported_timestamp >= 0 and (
            index == 0 or reported_timestamp > previous_timestamp
        ):
            timestamp, time_source = reported_timestamp, "decoder"
        else:
            timestamp = max(index / metadata.fps, previous_timestamp + 1 / metadata.fps)
            time_source = "fps_estimate"
            estimated_timestamps += 1
        previous_timestamp = timestamp
        if selected_end is not None and timestamp > selected_end + 1e-9:
            end_reached = True
            break
        if timestamp < start - 1e-9:
            continue
        included_count += 1
        yield DecodedSample(frame, index, timestamp, time_source)

    reconciled = decoded_count == metadata.frame_count if reached_eof else None
    complete = end_reached or (reached_eof and reconciled is True)
    coverage.update({
        "kind": "all_decoded_frames",
        "decode_complete": complete,
        "all_decoded_frames_in_range_included": True,
        "decoded_frames": decoded_count,
        "included_frames": included_count,
        "metadata_frame_count_matches": reconciled,
        "reached_eof": reached_eof,
        "fps_estimated_timestamps": estimated_timestamps,
    })
    if reached_eof and not reconciled:
        warnings.append(
            f"Decoded {decoded_count} frames but metadata declares {metadata.frame_count}. "
            "The decoder may have stopped early or the metadata may be inaccurate; full coverage is unverified."
        )
    if estimated_timestamps:
        warnings.append(
            f"{estimated_timestamps} timestamps used FPS estimates because decoder timestamps "
            "were unavailable or non-increasing; time-range boundaries may be approximate."
        )


def sampled_frames(
    capture: Any, cv2: Any, timestamps: Sequence[float], frame_duration: float,
) -> Iterable[DecodedSample]:
    for timestamp in timestamps:
        frame, source_index = read_frame(capture, cv2, timestamp, frame_duration)
        yield DecodedSample(frame, source_index, timestamp, "seek_target")


def write_contact_sheets(
    samples: Iterable[DecodedSample], args: argparse.Namespace, modules: tuple[Any, ...],
    run_directory: Path, strategy: str, total_sheets: int | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    cv2, _, Image, ImageDraw = modules
    frame_records: list[dict[str, Any]] = []
    sheet_records: list[dict[str, Any]] = []
    tiles: list[tuple[int, float, Any]] = []
    sheet_frames: list[dict[str, Any]] = []

    def flush() -> None:
        sheet_number = len(sheet_records) + 1
        sheet_path = run_directory / f"contact-sheet-{sheet_number:04d}.jpg"
        compose_sheet(
            Image, ImageDraw, tiles, args.columns, args.tile_width, sheet_number,
            total_sheets, strategy, sheet_path, args.jpeg_quality,
        )
        sheet_records.append({
            "sheet": sheet_number,
            "path": str(sheet_path),
            "frame_indices": [record["index"] for record in sheet_frames],
            "source_frame_start": sheet_frames[0]["source_frame_index"],
            "source_frame_end": sheet_frames[-1]["source_frame_index"],
            "start": sheet_frames[0]["timestamp"],
            "end": sheet_frames[-1]["timestamp"],
        })
        for _, _, tile in tiles:
            tile.close()
        tiles.clear()
        sheet_frames.clear()

    for sample in samples:
        display_index = len(frame_records) + 1
        image = Image.fromarray(cv2.cvtColor(sample.frame, cv2.COLOR_BGR2RGB))
        frame_path = None
        if args.keep_frames:
            frame_path = run_directory / f"frame-{display_index:06d}-source-{sample.source_frame_index:06d}.jpg"
            retained_frame(image, Image, args.full_frame_max_width).save(
                frame_path, format="JPEG", quality=args.jpeg_quality, optimize=True,
            )
        # Retain only one sheet of thumbnails, never a sheet of full-resolution
        # decoded images. All-frame mode can contain thousands of source frames.
        image.thumbnail((args.tile_width, args.tile_width * 2), Image.Resampling.LANCZOS)
        tiles.append((sample.source_frame_index, sample.timestamp, image))
        record = {
            "index": display_index,
            "timestamp_seconds": round(sample.timestamp, 6),
            "timestamp": format_time(sample.timestamp),
            "timestamp_source": sample.timestamp_source,
            "source_frame_index": sample.source_frame_index,
            "sheet": len(sheet_records) + 1,
            "cell": len(tiles),
            **({"path": str(frame_path)} if frame_path else {}),
        }
        frame_records.append(record)
        sheet_frames.append(record)
        if len(tiles) == args.sheet_size:
            flush()
    if tiles:
        flush()
    if not frame_records:
        raise RuntimeError("No frames were decoded inside the selected time range")
    return frame_records, sheet_records


def manifest_batch(payload: dict[str, Any], offset: int, limit: int, full: bool = False) -> dict[str, Any]:
    bounded(offset, 0, sys.maxsize, "--sheet-offset")
    bounded(limit, 1, 4, "--sheet-limit")
    if payload.get("schema") != SCHEMA or not isinstance(payload.get("contact_sheets"), list):
        raise ValueError("Not a video storyboard manifest")
    if full:
        return payload
    sheets = payload["contact_sheets"]
    if offset > len(sheets):
        raise ValueError("--sheet-offset is outside the manifest's contact sheets")
    end = min(len(sheets), offset + limit)
    return {
        **{key: value for key, value in payload.items() if key not in ("frames", "contact_sheets")},
        "contact_sheet_count": len(sheets),
        "contact_sheets": sheets[offset:end],
        "sheet_offset": offset,
        "next_sheet_offset": end if end < len(sheets) else None,
        "frame_records_in_manifest": payload.get("sampled_frames", 0),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    if not args.video:
        raise ValueError("video is required unless --check-dependencies or --read-manifest is used")
    if not args.output_dir:
        raise ValueError("--output-dir is required")
    if args.frames is not None:
        bounded(args.frames, 1, 120, "--frames")
    bounded(args.sheet_size, 4, 20, "--sheet-size")
    bounded(args.columns, 2, 5, "--columns")
    bounded(args.tile_width, 200, 640, "--tile-width")
    bounded(args.scene_threshold, 0, 1, "--scene-threshold")
    bounded(args.scene_scan_limit, 100, 5000, "--scene-scan-limit")
    bounded(args.full_frame_max_width, 640, 3840, "--full-frame-max-width")
    bounded(args.jpeg_quality, 70, 95, "--jpeg-quality")
    bounded(args.sheet_offset, 0, sys.maxsize, "--sheet-offset")
    bounded(args.sheet_limit, 1, 4, "--sheet-limit")
    for value, label in [(args.short_video_seconds, "--short-video-seconds"), (args.step, "--step")]:
        if value is not None and (not math.isfinite(value) or value <= 0):
            raise ValueError(f"{label} must be a finite positive number")

    source_candidate = Path(args.video).expanduser()
    if not source_candidate.exists():
        raise ValueError(f"video does not exist: {source_candidate}")
    source = source_candidate.resolve()
    if not source.is_file():
        raise ValueError(f"video is not a file: {source}")
    output_parent = Path(args.output_dir).expanduser().resolve()
    modules = load_media_modules()
    cv2, np, _, _ = modules
    capture, metadata = open_video(cv2, source)
    try:
        start = parse_time(args.start, "--start")
        requested_end = parse_time(args.end, "--end") if args.end is not None else None
        start, end, warnings = normalize_range(start, requested_end, metadata)
        duration = min(requested_end if requested_end is not None else metadata.duration_seconds,
                       metadata.duration_seconds) - start
        plan = sampling_plan(args, duration, metadata.fps)
        strategy = plan["strategy"]
        frame_duration = 1 / metadata.fps
        detected_scenes = None
        uniform_supplements = None
        coverage: dict[str, Any] = {"kind": "sampled", "all_decoded_frames_in_range_included": False}
        timestamps = None
        if strategy == "all":
            # Full-video decoding ends at EOF, not at duration estimated from FPS.
            # A selected interval is filtered by decoder timestamps during the same
            # sequential pass, avoiding imprecise seeks and repeated nearby frames.
            samples = sequential_frames(capture, cv2, metadata, start, requested_end, coverage, warnings)
        else:
            count = args.frames if args.frames is not None else 16
            if strategy == "sequence":
                timestamps = sequence_timestamps(start, end, count, plan["interval_seconds"])
                if len(timestamps) < count:
                    warnings.append("Sequence reached the selected range before the requested frame count.")
            elif strategy == "scenes":
                timestamps, detected_scenes, uniform_supplements = scene_timestamps(
                    capture, cv2, np, start, end, count, args.scene_threshold,
                    args.scene_scan_limit, frame_duration,
                )
                if uniform_supplements > 0:
                    warnings.append("Scene candidates were supplemented with uniform samples to preserve coverage.")
            elif strategy == "interval":
                step = plan["interval_seconds"]
                timestamps = sequence_timestamps(start, end, math.floor((end - start) / step) + 1, step)
                if end > timestamps[-1] + 1e-9:
                    timestamps.append(end)
            else:
                timestamps = uniform_timestamps(start, end, count)
            samples = sampled_frames(capture, cv2, timestamps, frame_duration)
            warnings.append("This is temporal sampling, not full-frame coverage; brief events may be absent.")
            warnings.append("Timestamps are decoder seek targets and may resolve to a nearby encoded frame.")

        run_directory = make_run_directory(output_parent)
        frame_records, sheet_records = write_contact_sheets(
            samples, args, modules, run_directory, strategy,
            math.ceil(len(timestamps) / args.sheet_size) if timestamps is not None else None,
        )
        payload: dict[str, Any] = {
            "schema": SCHEMA,
            "source": str(source),
            "run_directory": str(run_directory),
            "mode": args.mode,
            "sampling": plan,
            "coverage": coverage,
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
                "first_frame_timestamp": frame_records[0]["timestamp"],
                "last_frame_timestamp": frame_records[-1]["timestamp"],
            },
            "requested_frames": args.frames,
            "sampled_frames": len(frame_records),
            "contact_sheets": sheet_records,
            "frames": frame_records,
            "warnings": warnings + [
                "Decoder timestamps and FPS-derived duration may be approximate, especially for variable-frame-rate video.",
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
        if args.read_manifest:
            if args.video or args.output_dir:
                raise ValueError("--read-manifest cannot be combined with video or --output-dir")
            payload = json.loads(Path(args.read_manifest).expanduser().read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("Not a video storyboard manifest")
        else:
            payload = run(args)
        response = manifest_batch(payload, args.sheet_offset, args.sheet_limit, args.full_manifest)
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
    print(manifest_json(response, args.pretty, ascii_safe=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
