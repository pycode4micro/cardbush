"""Deterministic local composition. The original raster stays intact until edited."""
from __future__ import annotations

import io
import os
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from .layer_models import LayerError, TextStyle


def font_for(style: TextStyle):
    # Fonts are OS resources, never downloaded or bundled without a license.
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    candidates = [style.font_path] if style.font_path else [
        str(fonts / ("msyhbd.ttc" if style.bold else "msyh.ttc")),
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc" if style.bold else "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if style.bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        str(fonts / ("arialbd.ttf" if style.bold else "arial.ttf")),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if not path.is_absolute() or path.suffix.lower() not in {".ttf", ".otf", ".ttc"}:
            continue
        try:
            return ImageFont.truetype(str(path), max(1, round(style.font_size))), str(path)
        except OSError:
            continue
    raise LayerError("font_unavailable")


def text_image(style: TextStyle, width: int, height: int):
    font, _ = font_for(style)
    image = Image.new("RGBA", (width, height))
    draw = ImageDraw.Draw(image)
    if not style.content:
        return image
    bbox = draw.multiline_textbbox((0, 0), style.content, font=font, spacing=round(style.font_size * .2))
    draw.multiline_text((-bbox[0], -bbox[1]), style.content, font=font, fill=style.color,
                        spacing=round(style.font_size * .2))
    if style.italic:
        image = image.transform(image.size, Image.Transform.AFFINE, (1, -.18, height * .18, 0, 1, 0),
                                resample=Image.Resampling.BICUBIC)
    return image


def layer_image(directory: Path, layer: dict):
    width, height = max(1, round(layer["width"])), max(1, round(layer["height"]))
    if width * height > 36_000_000:
        raise LayerError("invalid_geometry")
    if layer.get("text") is not None:
        return text_image(TextStyle.model_validate(layer["text"]), width, height)
    target = (directory / layer["asset"]).resolve()
    if not target.is_relative_to(directory.resolve()):
        raise LayerError("invalid_asset")
    with Image.open(target) as source:
        return source.convert("RGBA").resize((width, height), Image.Resampling.LANCZOS)


def compose(directory: Path, document: dict):
    canvas = Image.new("RGBA", (document["width"], document["height"]))
    for layer in sorted(document["layers"], key=lambda item: item["z_index"]):
        if not layer["visible"] or layer["opacity"] <= 0:
            continue
        image = layer_image(directory, layer)
        if layer["opacity"] < 1:
            image.putalpha(image.getchannel("A").point(lambda value: round(value * layer["opacity"])))
        canvas.alpha_composite(image, (round(layer["x"]), round(layer["y"])))
    return canvas


def png_bytes(image: Image.Image, *, max_edge: int | None = None):
    if max_edge:
        image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()
