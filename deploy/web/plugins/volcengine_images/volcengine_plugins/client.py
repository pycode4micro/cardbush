from __future__ import annotations

import base64
import io
import json
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from PIL import Image

from .models import DEFAULT_MODEL, ImageRequest, LocalOptions, resolved_size
from .config import configuration_status, get_config

MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_OUTPUT_BYTES = 64 * 1024 * 1024
SOURCES = [
    "https://www.volcengine.com/docs/82379/1541523",
    "https://docs.byteplus.com/api/docs/ModelArk/1824121",
    "https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/resources/images/images.py",
    "https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/types/images/images.py",
]


class SeedreamError(RuntimeError):
    """Public, credential-safe error."""


def validate_image(raw: bytes) -> str:
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Reference image exceeds 30 MiB")
    try:
        with Image.open(io.BytesIO(raw)) as im:
            w, h = im.size
            mime = Image.MIME.get(im.format or "")
            im.verify()
        if not mime or not mime.startswith("image/"):
            raise ValueError
    except Exception:
        raise ValueError("Cannot validate reference image; convert unsupported HEIC/HEIF to PNG/JPEG first") from None
    if min(w, h) <= 14 or w * h > 36_000_000 or not 1 / 16 <= w / h <= 16:
        raise ValueError("Reference image violates dimensions (>14px), 36MP or aspect-ratio limits")
    return mime


def image_uri(path_string: str) -> str:
    path = Path(path_string).expanduser()
    if not path.is_absolute() or not path.is_file():
        raise ValueError("reference_images must contain existing absolute file paths")
    if path.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("Reference image exceeds 30 MiB")
    with path.open("rb") as handle:
        raw = handle.read(MAX_IMAGE_BYTES + 1)
    mime = validate_image(raw)
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def normalize_image(value: str) -> str:
    if value.startswith("data:image/"):
        if len(value) > MAX_IMAGE_BYTES * 4 // 3 + 256:
            raise ValueError("Reference image data URI exceeds limit")
        try:
            header, encoded = value.split(",", 1)
            if not header.endswith(";base64"):
                raise ValueError
            raw = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise ValueError("Invalid base64 image data URI") from None
        mime = validate_image(raw)
        return f"data:{mime};base64,{encoded}"
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("image requires an HTTPS URL or base64 image data URI; use local.reference_images for paths")
    # No local fetch. Ark validates remote-image content and size.
    return value


def prepare(request: ImageRequest, options: LocalOptions, default_model: str = DEFAULT_MODEL) -> tuple[dict, list[str]]:
    body = request.model_dump(exclude_none=True, exclude={"extra_body"})
    body["model"] = request.model or default_model
    if not request.prompt.strip():
        raise ValueError("prompt cannot be whitespace")
    reserved = set(ImageRequest.model_fields) | {"api_key", "authorization", "headers", "base_url", "url"}
    if reserved.intersection(k.lower() for k in request.extra_body):
        raise ValueError("extra_body cannot override declared parameters or transport/auth settings")
    body.update(request.extra_body)
    warnings = []
    if request.extra_body:
        warnings.append("extra_body fields are passed through without a model-support guarantee")
    if options.reference_images:
        if request.image is not None:
            raise ValueError("Use request.image OR local.reference_images, not both; preserves reference order")
        if len(options.reference_images) > 10:
            raise ValueError("This Pro-focused adapter accepts at most 10 reference images")
        body["image"] = [image_uri(path) for path in options.reference_images]
    if "image" in body:
        refs = body["image"] if isinstance(body["image"], list) else [body["image"]]
        if not refs or len(refs) > 10:
            raise ValueError("Provide 1..10 reference images")
        checked = [normalize_image(value) for value in refs]
        body["image"] = checked if isinstance(body["image"], list) else checked[0]
    convenience_size = resolved_size(options)
    if convenience_size:
        if request.size is not None:
            raise ValueError("request.size conflicts with local.aspect_ratio/resolution")
        body["size"] = convenience_size
    if "size" in body:
        size = body["size"]
        if size not in ("1K", "2K"):
            match = re.fullmatch(r"([1-9]\d*)x([1-9]\d*)", size)
            if not match:
                raise ValueError("Pro size must be 1K, 2K or WIDTHxHEIGHT")
            w, h = map(int, match.groups())
            if not (921600 <= w * h <= 4624220 and 1 / 16 <= w / h <= 16):
                raise ValueError("Pro size violates pixel area [921600,4624220] or ratio [1/16,16]")
    if request.stream:
        raise ValueError("stream=true is unsupported for Pro and this JSON-response adapter")
    if request.sequential_image_generation == "auto" or request.sequential_image_generation_options is not None:
        raise ValueError("Pro does not support ordinary sequential/batch image generation; call once per image")
    uncertain = [key for key in ("seed", "guidance_scale", "optimize_prompt", "tools") if key in body]
    if request.optimize_prompt_options and request.optimize_prompt_options.thinking is not None:
        uncertain.append("optimize_prompt_options.thinking")
    if uncertain:
        if not options.allow_unverified_parameters:
            raise ValueError("SDK fields not verified for Pro: " + ", ".join(uncertain) + "; explicitly set allow_unverified_parameters to forward")
        warnings.append("Provider must validate model-dependent fields: " + ", ".join(uncertain))
    if options.save_images and request.response_format is None:
        body["response_format"] = "b64_json"
    if options.save_images and body.get("response_format") == "url":
        warnings.append("Explicit URL mode: URLs are returned without downloading; choose b64_json for local files")
    return body, warnings


def redacted(value: Any, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: redacted(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [redacted(v, key) for v in value]
    if isinstance(value, str):
        if key.lower() in {"api_key", "authorization", "token", "secret"}:
            return "[redacted]"
        if value.startswith("data:image/") or key == "b64_json":
            return f"[base64 image omitted; {len(value)} characters]"
        if value.startswith("https://"):
            p = urlsplit(value)
            return f"https://{p.hostname}/[image URL omitted]"
    return value


class SeedreamClient:
    def __init__(self, *, api_key: str | None = None, base_url: str | None = None,
                 output_dir: Path | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.api_key = api_key if api_key is not None else get_config("ARK_API_KEY")
        self.base_url = (base_url if base_url is not None else get_config("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3")).rstrip("/")
        parsed = urlsplit(self.base_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("ARK_BASE_URL must be an HTTPS API base URL without credentials/query/fragment")
        self.output_dir = output_dir or Path(get_config("SEEDREAM_OUTPUT_DIR", str(Path.home() / "Pictures" / "Seedream")))
        self.transport = transport

    async def generate(self, request: ImageRequest, options: LocalOptions) -> dict:
        body, warnings = prepare(request, options, get_config("SEEDREAM_MODEL", DEFAULT_MODEL))
        return await self.generate_prepared(body, warnings, options)

    async def generate_prepared(self, body: dict, warnings: list, options: LocalOptions) -> dict:
        """Execute an already validated snapshot once (also used by background jobs)."""
        if not self.api_key.strip():
            raise SeedreamError("ARK_API_KEY is not configured; no API request was sent")
        try:
            timeout = float(get_config("SEEDREAM_TIMEOUT_SECONDS", "300"))
            async with httpx.AsyncClient(transport=self.transport, timeout=timeout, follow_redirects=False) as client:
                # Exactly one POST: ambiguous failures must never trigger paid automatic retries.
                response = await client.post(self.base_url + "/images/generations", json=body,
                                             headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        except httpx.TransportError:
            raise SeedreamError("Network failure; provider may have accepted the paid request. No retry performed. Check Ark usage before retrying.") from None
        request_id = response.headers.get("x-request-id") or response.headers.get("x-tt-logid")
        try:
            payload = response.json()
        except ValueError:
            raise SeedreamError(f"Non-JSON provider response (HTTP {response.status_code}); no retry performed") from None
        if not isinstance(payload, dict):
            raise SeedreamError("Unexpected provider response shape; no retry performed")
        if response.is_error or response.is_redirect or payload.get("error"):
            error = payload.get("error")
            code = error.get("code") if isinstance(error, dict) else None
            # Do not expose provider message: may echo credentials, input images or signed URLs.
            safe_code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", code) else "unknown"
            safe_id = request_id if request_id and re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", request_id) else "unavailable"
            raise SeedreamError(f"Ark HTTP {response.status_code}; code={safe_code}; request_id={safe_id}; no retry performed")
        data = payload.get("data")
        if not isinstance(data, list) or not data:
            raise SeedreamError("Provider returned no image data; no retry performed")
        result = {k: v for k, v in payload.items() if k != "data"}
        result.update({"request_id": request_id, "warnings": warnings, "data": []})
        # Preserve every image/layer, not only data[0]. Never accept provider filenames as paths.
        for item in data:
            if not isinstance(item, dict):
                raise SeedreamError("Invalid provider image entry")
            entry = dict(item)
            encoded = entry.pop("b64_json", None)
            if encoded is not None:
                if not options.save_images:
                    entry["b64_json"] = encoded
                else:
                    try:
                        if not isinstance(encoded, str) or len(encoded) > MAX_OUTPUT_BYTES * 4 // 3 + 4:
                            raise ValueError
                        raw = base64.b64decode(encoded, validate=True)
                        with Image.open(io.BytesIO(raw)) as im:
                            extension = {"PNG": ".png", "JPEG": ".jpg"}.get(im.format)
                            im.verify()
                        if not extension:
                            raise ValueError
                    except Exception:
                        entry["save_error"] = "Invalid/unsupported/oversized image bytes; provider generation may still be charged"
                    else:
                        try:
                            self.output_dir.mkdir(parents=True, exist_ok=True)
                            target = self.output_dir.resolve() / (uuid.uuid4().hex + extension)
                            with target.open("xb") as handle:
                                handle.write(raw)
                            entry["local_path"] = str(target)
                        except OSError:
                            entry["save_error"] = "Cannot write output directory; provider generation already completed"
            result["data"].append(entry)
        return result


def capabilities() -> dict:
    config = configuration_status()
    return {
        "default_model": get_config("SEEDREAM_MODEL", DEFAULT_MODEL),
        "configured": config["variables"]["ARK_API_KEY"]["configured"],
        "configuration": config,
        "endpoint": "POST /api/v3/images/generations",
        "profile": "Seedream 5.0 Pro (not the union of all Seedream model capabilities)",
        "sizes": ["1K", "2K", "WIDTHxHEIGHT"], "max_reference_images": 10,
        "pixel_area": [921600, 4624220], "aspect_ratio": ["1:16", "16:1"],
        "streaming": False, "ordinary_batch": False, "layer_decomposition": True,
        "official_request_schema": ImageRequest.model_json_schema(),
        "local_options_schema": LocalOptions.model_json_schema(),
        "sources": SOURCES,
        "verification_note": "Parameter union verified against Volcengine SDK; Pro capability limits from official BytePlus tutorial. China-region account/model availability requires a live call; not prevalidated.",
    }
