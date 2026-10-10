from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DEFAULT_MODEL = "doubao-seedream-5-0-pro-260628"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


class OptimizePromptOptions(StrictModel):
    mode: Literal["standard", "fast"] | None = None
    thinking: str | None = Field(None, description="Official SDK field; support depends on model.")


class SequentialOptions(StrictModel):
    max_images: int | None = Field(None, ge=1, description="Model-dependent; not ordinary Pro batch generation.")


class GenerationTool(StrictModel):
    type: str = Field(description="Official SDK tool type; availability is model/account dependent.")


class ImageRequest(StrictModel):
    prompt: str = Field(min_length=1, description="Official prompt. Be explicit about text, composition and reference image roles.")
    model: str | None = Field(None, description="Official model ID or your Ark endpoint ID. Defaults to SEEDREAM_MODEL or Seedream 5.0 Pro.")
    image: str | list[str] | None = Field(None, description="Official image input: public HTTPS URL or data:image/...;base64,..., in reference order.")
    size: str | None = Field(None, description="Official size: Pro supports 1K, 2K or WIDTHxHEIGHT. Not a quality field.")
    response_format: Literal["url", "b64_json"] | None = None
    output_format: Literal["png", "jpeg"] | None = None
    watermark: bool | None = None
    seed: int | None = Field(None, description="Official multi-model SDK parameter; Pro support not established.")
    guidance_scale: float | None = Field(None, description="Official multi-model SDK parameter; Pro support not established.")
    optimize_prompt: bool | None = Field(None, description="Legacy SDK field; prefer optimize_prompt_options when appropriate.")
    optimize_prompt_options: OptimizePromptOptions | None = None
    sequential_image_generation: Literal["auto", "disabled"] | None = None
    sequential_image_generation_options: SequentialOptions | None = None
    tools: list[GenerationTool] | None = None
    layer_decomposition: bool | None = Field(None, description="Official SDK layer decomposition flag; retain every returned layer and its metadata.")
    stream: bool | None = Field(None, description="Pro does not support stream=true; this adapter handles JSON responses only.")
    extra_body: dict[str, Any] = Field(default_factory=dict, description="Explicit forward-compatible official JSON fields; cannot overwrite declared fields. Provider validates new fields.")


class LocalOptions(StrictModel):
    reference_images: list[str] = Field(default_factory=list, description="Absolute local image file paths, converted to data URIs without editing. Cannot combine with request.image.")
    aspect_ratio: str | None = Field(None, description="Convenience only, e.g. 9:16. Converted into official size with resolution; never sent as aspect_ratio.")
    resolution: Literal["1K", "2K"] | None = Field(None, description="Convenience resolution. With aspect_ratio computes WIDTHxHEIGHT. Conflicts with request.size.")
    save_images: bool = Field(True, description="Save base64 outputs under SEEDREAM_OUTPUT_DIR. If response_format is omitted, selects b64_json. Explicit URL mode returns URLs without downloading.")
    allow_unverified_parameters: bool = Field(False, description="Explicitly pass model-dependent fields not verified for Pro. Does not bypass known unsupported streaming/batch constraints.")

    @model_validator(mode="after")
    def check_ratio(self):
        if self.aspect_ratio:
            try:
                a, b = map(float, self.aspect_ratio.split(":"))
                if not (math.isfinite(a) and math.isfinite(b) and a > 0 and b > 0 and 1 / 16 <= a / b <= 16):
                    raise ValueError
            except (ValueError, ZeroDivisionError):
                raise ValueError("aspect_ratio must be positive W:H within 1:16..16:1") from None
        return self


def resolved_size(options: LocalOptions) -> str | None:
    if not options.aspect_ratio:
        return options.resolution
    a, b = map(float, options.aspect_ratio.split(":"))
    area = (2048 if options.resolution == "2K" else 1024) ** 2
    # Round to 8-pixel multiples; enforce actual resulting area below.
    w = round(math.sqrt(area * a / b) / 8) * 8
    h = round(math.sqrt(area * b / a) / 8) * 8
    return f"{w}x{h}"
