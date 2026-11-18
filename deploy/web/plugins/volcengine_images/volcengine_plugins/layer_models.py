"""Editable document contract. Provider OCR remains data and is never executed."""
from __future__ import annotations

from typing import Literal
from pydantic import Field
from .models import StrictModel


class TextStyle(StrictModel):
    content: str = Field(max_length=12000)
    font_size: float = Field(default=32, ge=1, le=1000, allow_inf_nan=False)
    color: str = Field(default="#202020", pattern=r"^#[0-9a-fA-F]{6}$")
    bold: bool = False
    italic: bool = False
    font_path: str | None = Field(None, max_length=4096, description="Optional absolute local TTF/OTF/TTC font path. No remote font fetch.")


class LayerChange(StrictModel):
    id: str = Field(pattern=r"^layer-[0-9]{3}$")
    name: str | None = Field(None, max_length=160)
    x: float | None = Field(None, ge=-32768, le=32768, allow_inf_nan=False)
    y: float | None = Field(None, ge=-32768, le=32768, allow_inf_nan=False)
    width: float | None = Field(None, ge=1, le=8192, allow_inf_nan=False)
    height: float | None = Field(None, ge=1, le=8192, allow_inf_nan=False)
    visible: bool | None = None
    opacity: float | None = Field(None, ge=0, le=1, allow_inf_nan=False)
    z_index: int | None = Field(None, ge=-1000, le=1000)
    text: TextStyle | None = Field(None, description="Explicit text replaces this layer's pixels with locally rendered text. Null restores the image layer. OCR fonts/layout are approximate.")
    replacement_path: str | None = Field(None, max_length=4096, description="Absolute local image to copy into this layer, preserving its placement. No AI call or source overwrite.")


class LayerError(ValueError):
    def __init__(self, code: str, **details):
        self.code, self.details = code, details
        super().__init__(code)


ExportFormat = Literal["png", "jpeg", "zip"]
