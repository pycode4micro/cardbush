from __future__ import annotations

import base64
import mimetypes
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from PIL import Image, UnidentifiedImageError

WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"

IMAGE_KIND = "image"
FILE_KIND = "file"
VIDEO_KIND = "video"

_VOICE_SUFFIX_BY_ENCODE_TYPE = {
    1: ".pcm",
    2: ".adpcm",
    4: ".speex",
    5: ".amr",
    6: ".silk",
    7: ".mp3",
    8: ".ogg",
}
_VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
_AES_STREAM_CHUNK_SIZE = 64 * 1024


@dataclass(slots=True)
class DownloadedWeixinMedia:
    kind: str
    content: bytes
    temp_path: str | None = None
    file_name: str | None = None
    mime_type: str | None = None


@dataclass(slots=True)
class UploadedWeixinMedia:
    kind: str
    filekey: str
    download_encrypted_query_param: str
    aes_key_hex: str
    file_size: int
    file_size_ciphertext: int
    file_name: str | None = None


def aes_ecb_padded_size(plaintext_size: int) -> int:
    normalized_size = max(0, int(plaintext_size))
    return ((normalized_size // 16) + 1) * 16


def _normalize_stream_chunk_size(chunk_size: int) -> int:
    normalized = max(16, int(chunk_size))
    remainder = normalized % 16
    if remainder:
        normalized += 16 - remainder
    return normalized



def encrypt_aes_ecb_stream(
    plaintext_stream: BinaryIO,
    ciphertext_stream: BinaryIO,
    *,
    key: bytes,
    chunk_size: int = _AES_STREAM_CHUNK_SIZE,
) -> int:
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    encryptor = cipher.encryptor()
    padder = padding.PKCS7(128).padder()
    normalized_chunk_size = _normalize_stream_chunk_size(chunk_size)
    total_written = 0
    while True:
        chunk = plaintext_stream.read(normalized_chunk_size)
        if not chunk:
            break
        padded = padder.update(chunk)
        if padded:
            encrypted = encryptor.update(padded)
            if encrypted:
                ciphertext_stream.write(encrypted)
                total_written += len(encrypted)
    final_padded = padder.finalize()
    final_encrypted = b""
    if final_padded:
        final_encrypted += encryptor.update(final_padded)
    final_encrypted += encryptor.finalize()
    if final_encrypted:
        ciphertext_stream.write(final_encrypted)
        total_written += len(final_encrypted)
    return total_written


def decrypt_aes_ecb_stream(
    ciphertext_stream: BinaryIO,
    plaintext_stream: BinaryIO,
    *,
    key: bytes,
    chunk_size: int = _AES_STREAM_CHUNK_SIZE,
) -> int:
    cipher = Cipher(algorithms.AES(key), modes.ECB())
    decryptor = cipher.decryptor()
    unpadder = padding.PKCS7(128).unpadder()
    normalized_chunk_size = _normalize_stream_chunk_size(chunk_size)
    total_written = 0
    while True:
        chunk = ciphertext_stream.read(normalized_chunk_size)
        if not chunk:
            break
        decrypted = decryptor.update(chunk)
        if decrypted:
            plaintext = unpadder.update(decrypted)
            if plaintext:
                plaintext_stream.write(plaintext)
                total_written += len(plaintext)
    final_decrypted = decryptor.finalize()
    final_plaintext = b""
    if final_decrypted:
        final_plaintext += unpadder.update(final_decrypted)
    final_plaintext += unpadder.finalize()
    if final_plaintext:
        plaintext_stream.write(final_plaintext)
        total_written += len(final_plaintext)
    return total_written


def parse_cdn_media_aes_key(aes_key_base64: str) -> bytes:
    decoded = base64.b64decode(str(aes_key_base64 or "").strip())
    if len(decoded) == 16:
        return decoded
    decoded_text = decoded.decode("ascii", errors="ignore")
    if len(decoded) == 32 and decoded_text and all(
        character in "0123456789abcdefABCDEF" for character in decoded_text
    ):
        return bytes.fromhex(decoded_text)
    raise ValueError(
        "aes_key must decode to 16 raw bytes or a 32-char hex string"
    )


def encode_aes_key_for_message(aes_key_hex: str) -> str:
    return base64.b64encode(str(aes_key_hex or "").encode("ascii")).decode("ascii")


def build_cdn_download_url(
    encrypted_query_param: str,
    *,
    cdn_base_url: str,
) -> str:
    from urllib.parse import quote

    return (
        f"{str(cdn_base_url).rstrip('/')}/download"
        f"?encrypted_query_param={quote(str(encrypted_query_param or '').strip(), safe='')}"
    )


def build_cdn_upload_url(
    *,
    upload_param: str,
    filekey: str,
    cdn_base_url: str,
) -> str:
    from urllib.parse import quote

    return (
        f"{str(cdn_base_url).rstrip('/')}/upload"
        f"?encrypted_query_param={quote(str(upload_param or '').strip(), safe='')}"
        f"&filekey={quote(str(filekey or '').strip(), safe='')}"
    )



def guess_image_suffix_from_path(image_path: str | Path) -> str:
    try:
        with Image.open(str(image_path)) as image:
            image_format = str(image.format or "").strip().lower()
    except (UnidentifiedImageError, OSError, ValueError):
        return ".png"
    if image_format == "jpeg":
        return ".jpg"
    if image_format:
        return f".{image_format}"
    return ".png"


def guess_mime_type_from_name(file_name: str | None) -> str | None:
    guessed, _ = mimetypes.guess_type(str(file_name or "").strip())
    normalized = str(guessed or "").strip().lower()
    return normalized or None


def outbound_media_kind_for_path(file_path: str | Path) -> str:
    suffix = str(Path(file_path).suffix or "").strip().lower()
    mime_type = str(
        mimetypes.guess_type(str(file_path))[0] or ""
    ).strip().lower()
    if mime_type.startswith("image/"):
        return IMAGE_KIND
    if mime_type.startswith("video/") or suffix in _VIDEO_SUFFIXES:
        return VIDEO_KIND
    return FILE_KIND


def infer_voice_file_name(
    *,
    encode_type: object | None,
    message_id: str | None,
) -> str:
    try:
        normalized_encode_type = int(encode_type)
    except (TypeError, ValueError):
        normalized_encode_type = 6
    suffix = _VOICE_SUFFIX_BY_ENCODE_TYPE.get(normalized_encode_type, ".silk")
    stem = str(message_id or "").strip() or "voice"
    return f"{stem}{suffix}"
