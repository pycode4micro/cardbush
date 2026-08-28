from __future__ import annotations

import asyncio
import base64
import hashlib
import random
import secrets
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from cardbush_app.network import build_httpx_async_client

from .config import WeixinBotSettings
from .media import (
    FILE_KIND,
    IMAGE_KIND,
    VIDEO_KIND,
    DownloadedWeixinMedia,
    UploadedWeixinMedia,
    aes_ecb_padded_size,
    build_cdn_download_url,
    build_cdn_upload_url,
    decrypt_aes_ecb_stream,
    encode_aes_key_for_message,
    encrypt_aes_ecb_stream,
    guess_image_suffix_from_path,
    guess_mime_type_from_name,
    infer_voice_file_name,
    outbound_media_kind_for_path,
    parse_cdn_media_aes_key,
)

SESSION_EXPIRED_ERRCODE = -14
_GET_UPDATES_REQUEST_MAX_ATTEMPTS = 2
_GET_UPDATES_REQUEST_RETRY_DELAY_SECONDS = 0.25
_BUFFERED_CDN_UPLOAD_MAX_BYTES = 16 * 1024 * 1024


@dataclass(slots=True)
class QRCodeStartResult:
    qrcode: str
    qrcode_url: str


@dataclass(slots=True)
class QRCodeStatusResult:
    status: str
    bot_token: str | None = None
    account_id: str | None = None
    base_url: str | None = None
    user_id: str | None = None
    redirect_host: str | None = None


@dataclass(slots=True)
class WeixinMessage:
    raw: dict[str, Any]

    @property
    def from_user_id(self) -> str:
        return str(self.raw.get("from_user_id") or "").strip()

    @property
    def context_token(self) -> str | None:
        return str(self.raw.get("context_token") or "").strip() or None

    @property
    def message_id(self) -> str | None:
        raw_message_id = self.raw.get("message_id")
        if raw_message_id in (None, ""):
            return None
        return str(raw_message_id).strip() or None


@dataclass(slots=True)
class GetUpdatesResult:
    ret: int
    errcode: int | None
    errmsg: str | None
    messages: list[WeixinMessage]
    sync_buffer: str
    longpolling_timeout_ms: int | None


class WeixinClient:
    def __init__(
        self,
        settings: WeixinBotSettings,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._settings = settings
        self._http_client = http_client
        self._owned_http_client: httpx.AsyncClient | None = None
        self._owned_proxy_http_client: httpx.AsyncClient | None = None

    async def aclose(self) -> None:
        await self._close_owned_clients()

    async def reset_connections(self) -> None:
        await self._close_owned_clients()

    async def _close_owned_clients(self) -> None:
        client = self._owned_http_client
        proxy_client = self._owned_proxy_http_client
        self._owned_http_client = None
        self._owned_proxy_http_client = None
        if client is not None:
            await client.aclose()
        if proxy_client is not None:
            await proxy_client.aclose()

    async def start_qr_login(self) -> QRCodeStartResult:
        query = str(httpx.QueryParams({"bot_type": self._settings.bot_type}))
        response = await self._request(
            "GET",
            self._settings.login_base_url,
            f"ilink/bot/get_bot_qrcode?{query}",
            timeout_seconds=self._settings.api_timeout_seconds,
            authenticated=False,
        )
        payload = self._load_json(response)
        qrcode = str(payload.get("qrcode") or "").strip()
        qrcode_url = str(payload.get("qrcode_img_content") or "").strip()
        if not qrcode or not qrcode_url:
            raise RuntimeError(f"unexpected qrcode response: {payload}")
        return QRCodeStartResult(qrcode=qrcode, qrcode_url=qrcode_url)

    async def get_qr_status(
        self,
        *,
        qrcode: str,
        base_url: str,
    ) -> QRCodeStatusResult:
        query = str(httpx.QueryParams({"qrcode": qrcode}))
        try:
            response = await self._request(
                "GET",
                base_url,
                f"ilink/bot/get_qrcode_status?{query}",
                timeout_seconds=self._settings.poll_timeout_seconds,
                authenticated=False,
            )
        except httpx.TimeoutException:
            return QRCodeStatusResult(status="wait")
        payload = self._load_json(response)
        return QRCodeStatusResult(
            status=str(payload.get("status") or "").strip() or "wait",
            bot_token=str(payload.get("bot_token") or "").strip() or None,
            account_id=str(payload.get("ilink_bot_id") or "").strip() or None,
            base_url=str(payload.get("baseurl") or "").strip() or None,
            user_id=str(payload.get("ilink_user_id") or "").strip() or None,
            redirect_host=str(payload.get("redirect_host") or "").strip() or None,
        )

    async def get_updates(
        self,
        *,
        base_url: str,
        token: str,
        sync_buffer: str,
        timeout_seconds: float,
    ) -> GetUpdatesResult:
        last_request_error: httpx.RequestError | None = None
        for attempt in range(1, _GET_UPDATES_REQUEST_MAX_ATTEMPTS + 1):
            try:
                response = await self._request(
                    "POST",
                    base_url,
                    "ilink/bot/getupdates",
                    timeout_seconds=timeout_seconds,
                    authenticated=True,
                    token=token,
                    json_body={
                        "get_updates_buf": sync_buffer,
                        "base_info": self._build_base_info(),
                    },
                )
                break
            except httpx.TimeoutException:
                return GetUpdatesResult(
                    ret=0,
                    errcode=None,
                    errmsg=None,
                    messages=[],
                    sync_buffer=sync_buffer,
                    longpolling_timeout_ms=None,
                )
            except httpx.RequestError as exc:
                last_request_error = exc
                if attempt >= _GET_UPDATES_REQUEST_MAX_ATTEMPTS:
                    raise
                await self._close_owned_clients()
                await asyncio.sleep(_GET_UPDATES_REQUEST_RETRY_DELAY_SECONDS)
        else:
            if last_request_error is not None:
                raise last_request_error
            raise RuntimeError("Weixin getupdates request did not complete")
        payload = self._load_json(response)
        messages: list[WeixinMessage] = []
        raw_messages = payload.get("msgs")
        if isinstance(raw_messages, list):
            for item in raw_messages:
                if isinstance(item, dict):
                    messages.append(WeixinMessage(raw=item))
        longpolling_timeout_ms = payload.get("longpolling_timeout_ms")
        if not isinstance(longpolling_timeout_ms, int):
            longpolling_timeout_ms = None
        return GetUpdatesResult(
            ret=int(payload.get("ret") or 0),
            errcode=(
                int(payload["errcode"])
                if payload.get("errcode") not in (None, "")
                else None
            ),
            errmsg=str(payload.get("errmsg") or "").strip() or None,
            messages=messages,
            sync_buffer=str(payload.get("get_updates_buf") or sync_buffer),
            longpolling_timeout_ms=longpolling_timeout_ms,
        )

    async def send_text(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        text: str,
        context_token: str | None,
    ) -> None:
        msg: dict[str, Any] = {
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": self._build_client_id(),
            "message_type": 2,
            "message_state": 2,
            "item_list": [
                {
                    "type": 1,
                    "text_item": {"text": text},
                }
            ],
        }
        if context_token:
            msg["context_token"] = context_token
        await self._request(
            "POST",
            base_url,
            "ilink/bot/sendmessage",
            timeout_seconds=self._settings.api_timeout_seconds,
            authenticated=True,
            token=token,
            json_body={
                "msg": msg,
                "base_info": self._build_base_info(),
            },
        )

    async def send_path(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        file_path: str | Path,
        context_token: str | None,
        caption: str = "",
        force_file_kind: bool = False,
    ) -> str:
        target_path = Path(file_path).expanduser().resolve(strict=False)
        if not target_path.exists() or not target_path.is_file():
            raise FileNotFoundError(target_path)
        uploaded = await self._upload_media_from_path(
            base_url=base_url,
            token=token,
            to_user_id=to_user_id,
            file_path=target_path,
            media_kind_override=FILE_KIND if force_file_kind else None,
        )
        media_kind = uploaded.kind
        if media_kind == IMAGE_KIND:
            await self._send_uploaded_image(
                base_url=base_url,
                token=token,
                to_user_id=to_user_id,
                context_token=context_token,
                caption=caption,
                uploaded=uploaded,
            )
        elif media_kind == VIDEO_KIND:
            await self._send_uploaded_video(
                base_url=base_url,
                token=token,
                to_user_id=to_user_id,
                context_token=context_token,
                caption=caption,
                uploaded=uploaded,
            )
        else:
            await self._send_uploaded_file(
                base_url=base_url,
                token=token,
                to_user_id=to_user_id,
                context_token=context_token,
                caption=caption,
                uploaded=uploaded,
            )
        return media_kind

    async def download_media_item(
        self,
        *,
        item: dict[str, Any],
    ) -> DownloadedWeixinMedia | None:
        item_type = item.get("type")
        if item_type == 2:
            image_item = item.get("image_item")
            if not isinstance(image_item, dict):
                return None
            media = image_item.get("media")
            if not isinstance(media, dict):
                return None
            encrypted_query_param = str(media.get("encrypt_query_param") or "").strip()
            full_url = str(media.get("full_url") or "").strip() or None
            aes_key_hex = str(image_item.get("aeskey") or "").strip()
            aes_key_base64 = str(media.get("aes_key") or "").strip()
            if not encrypted_query_param and not full_url:
                return None
            payload_path = await self._download_cdn_payload_to_temp_path(
                encrypted_query_param=encrypted_query_param,
                full_url=full_url,
            )
            try:
                if aes_key_hex:
                    content_path = self._decrypt_temp_file_to_temp_path(
                        ciphertext_path=payload_path,
                        aes_key=bytes.fromhex(aes_key_hex),
                    )
                    payload_path.unlink(missing_ok=True)
                elif aes_key_base64:
                    content_path = self._decrypt_temp_file_to_temp_path(
                        ciphertext_path=payload_path,
                        aes_key=parse_cdn_media_aes_key(aes_key_base64),
                    )
                    payload_path.unlink(missing_ok=True)
                else:
                    content_path = payload_path
            except Exception:
                payload_path.unlink(missing_ok=True)
                raise
            return DownloadedWeixinMedia(
                kind=IMAGE_KIND,
                content=b"",
                temp_path=str(content_path),
                file_name=None,
                mime_type=f"image/{guess_image_suffix_from_path(content_path).lstrip('.')}",
            )

        if item_type == 3:
            voice_item = item.get("voice_item")
            if not isinstance(voice_item, dict):
                return None
            media = voice_item.get("media")
            if not isinstance(media, dict):
                return None
            encrypted_query_param = str(media.get("encrypt_query_param") or "").strip()
            full_url = str(media.get("full_url") or "").strip() or None
            aes_key_base64 = str(media.get("aes_key") or "").strip()
            if (not encrypted_query_param and not full_url) or not aes_key_base64:
                return None
            payload_path = await self._download_cdn_payload_to_temp_path(
                encrypted_query_param=encrypted_query_param,
                full_url=full_url,
            )
            try:
                content_path = self._decrypt_temp_file_to_temp_path(
                    ciphertext_path=payload_path,
                    aes_key=parse_cdn_media_aes_key(aes_key_base64),
                )
            finally:
                payload_path.unlink(missing_ok=True)
            return DownloadedWeixinMedia(
                kind="voice",
                content=b"",
                temp_path=str(content_path),
                file_name=infer_voice_file_name(
                    encode_type=voice_item.get("encode_type"),
                    message_id=item.get("msg_id"),
                ),
                mime_type="audio/silk",
            )

        if item_type == 4:
            file_item = item.get("file_item")
            if not isinstance(file_item, dict):
                return None
            media = file_item.get("media")
            if not isinstance(media, dict):
                return None
            encrypted_query_param = str(media.get("encrypt_query_param") or "").strip()
            full_url = str(media.get("full_url") or "").strip() or None
            aes_key_base64 = str(media.get("aes_key") or "").strip()
            if (not encrypted_query_param and not full_url) or not aes_key_base64:
                return None
            payload_path = await self._download_cdn_payload_to_temp_path(
                encrypted_query_param=encrypted_query_param,
                full_url=full_url,
            )
            try:
                content_path = self._decrypt_temp_file_to_temp_path(
                    ciphertext_path=payload_path,
                    aes_key=parse_cdn_media_aes_key(aes_key_base64),
                )
            finally:
                payload_path.unlink(missing_ok=True)
            file_name = str(file_item.get("file_name") or "").strip() or None
            return DownloadedWeixinMedia(
                kind=FILE_KIND,
                content=b"",
                temp_path=str(content_path),
                file_name=file_name,
                mime_type=guess_mime_type_from_name(file_name),
            )

        if item_type == 5:
            video_item = item.get("video_item")
            if not isinstance(video_item, dict):
                return None
            media = video_item.get("media")
            if not isinstance(media, dict):
                return None
            encrypted_query_param = str(media.get("encrypt_query_param") or "").strip()
            full_url = str(media.get("full_url") or "").strip() or None
            aes_key_base64 = str(media.get("aes_key") or "").strip()
            if (not encrypted_query_param and not full_url) or not aes_key_base64:
                return None
            payload_path = await self._download_cdn_payload_to_temp_path(
                encrypted_query_param=encrypted_query_param,
                full_url=full_url,
            )
            try:
                content_path = self._decrypt_temp_file_to_temp_path(
                    ciphertext_path=payload_path,
                    aes_key=parse_cdn_media_aes_key(aes_key_base64),
                )
            finally:
                payload_path.unlink(missing_ok=True)
            return DownloadedWeixinMedia(
                kind=VIDEO_KIND,
                content=b"",
                temp_path=str(content_path),
                file_name=None,
                mime_type="video/mp4",
            )
        return None

    async def _upload_media_from_path(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        file_path: Path,
        media_kind_override: str | None = None,
    ) -> UploadedWeixinMedia:
        file_size = file_path.stat().st_size
        file_size_ciphertext = aes_ecb_padded_size(file_size)
        rawfilemd5 = self._hash_file_md5(file_path)
        filekey = secrets.token_hex(16)
        aes_key = secrets.token_bytes(16)
        aes_key_hex = aes_key.hex()
        media_kind = str(media_kind_override or "").strip() or outbound_media_kind_for_path(
            file_path
        )
        if media_kind not in {IMAGE_KIND, VIDEO_KIND, FILE_KIND}:
            media_kind = outbound_media_kind_for_path(file_path)
        media_type = 1 if media_kind == IMAGE_KIND else 2 if media_kind == VIDEO_KIND else 3
        upload_url_payload = {
            "filekey": filekey,
            "media_type": media_type,
            "to_user_id": to_user_id,
            "rawsize": file_size,
            "rawfilemd5": rawfilemd5,
            "filesize": file_size_ciphertext,
            "no_need_thumb": True,
            "aeskey": aes_key_hex,
        }
        response = await self._request(
            "POST",
            base_url,
            "ilink/bot/getuploadurl",
            timeout_seconds=self._settings.media_timeout_seconds,
            authenticated=True,
            token=token,
            json_body={
                **upload_url_payload,
                "base_info": self._build_base_info(),
            },
        )
        payload = self._load_json(response)
        upload_full_url = str(payload.get("upload_full_url") or "").strip() or None
        upload_param = str(payload.get("upload_param") or "").strip() or None
        ciphertext_path = self._encrypt_file_to_temp_path(
            plaintext_path=file_path,
            aes_key=aes_key,
        )
        try:
            download_encrypted_query_param = await self._upload_cdn_ciphertext_file(
                ciphertext_path=ciphertext_path,
                upload_full_url=upload_full_url,
                upload_param=upload_param,
                filekey=filekey,
            )
        finally:
            ciphertext_path.unlink(missing_ok=True)
        return UploadedWeixinMedia(
            kind=media_kind,
            filekey=filekey,
            download_encrypted_query_param=download_encrypted_query_param,
            aes_key_hex=aes_key_hex,
            file_size=file_size,
            file_size_ciphertext=file_size_ciphertext,
            file_name=file_path.name,
        )

    async def _send_uploaded_image(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        context_token: str | None,
        caption: str,
        uploaded: UploadedWeixinMedia,
    ) -> None:
        image_item = {
            "type": 2,
            "image_item": {
                "media": {
                    "encrypt_query_param": uploaded.download_encrypted_query_param,
                    "aes_key": encode_aes_key_for_message(uploaded.aes_key_hex),
                    "encrypt_type": 1,
                },
                "mid_size": uploaded.file_size_ciphertext,
            },
        }
        await self._send_message_items(
            base_url=base_url,
            token=token,
            to_user_id=to_user_id,
            context_token=context_token,
            caption=caption,
            media_item=image_item,
        )

    async def _send_uploaded_video(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        context_token: str | None,
        caption: str,
        uploaded: UploadedWeixinMedia,
    ) -> None:
        video_item = {
            "type": 5,
            "video_item": {
                "media": {
                    "encrypt_query_param": uploaded.download_encrypted_query_param,
                    "aes_key": encode_aes_key_for_message(uploaded.aes_key_hex),
                    "encrypt_type": 1,
                },
                "video_size": uploaded.file_size_ciphertext,
            },
        }
        await self._send_message_items(
            base_url=base_url,
            token=token,
            to_user_id=to_user_id,
            context_token=context_token,
            caption=caption,
            media_item=video_item,
        )

    async def _send_uploaded_file(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        context_token: str | None,
        caption: str,
        uploaded: UploadedWeixinMedia,
    ) -> None:
        file_item = {
            "type": 4,
            "file_item": {
                "media": {
                    "encrypt_query_param": uploaded.download_encrypted_query_param,
                    "aes_key": encode_aes_key_for_message(uploaded.aes_key_hex),
                    "encrypt_type": 1,
                },
                "file_name": uploaded.file_name or "attachment.bin",
                "len": str(uploaded.file_size),
            },
        }
        await self._send_message_items(
            base_url=base_url,
            token=token,
            to_user_id=to_user_id,
            context_token=context_token,
            caption=caption,
            media_item=file_item,
        )

    async def _send_message_items(
        self,
        *,
        base_url: str,
        token: str,
        to_user_id: str,
        context_token: str | None,
        caption: str,
        media_item: dict[str, Any],
    ) -> None:
        items: list[dict[str, Any]] = []
        normalized_caption = str(caption or "").strip()
        if normalized_caption:
            items.append(
                {
                    "type": 1,
                    "text_item": {"text": normalized_caption},
                }
            )
        items.append(media_item)
        for item in items:
            msg: dict[str, Any] = {
                "from_user_id": "",
                "to_user_id": to_user_id,
                "client_id": self._build_client_id(),
                "message_type": 2,
                "message_state": 2,
                "item_list": [item],
            }
            if context_token:
                msg["context_token"] = context_token
            await self._request(
                "POST",
                base_url,
                "ilink/bot/sendmessage",
                timeout_seconds=self._settings.media_timeout_seconds,
                authenticated=True,
                token=token,
                json_body={
                    "msg": msg,
                    "base_info": self._build_base_info(),
                },
            )


    async def _download_cdn_payload_to_temp_path(
        self,
        *,
        encrypted_query_param: str,
        full_url: str | None,
    ) -> Path:
        target_url = str(full_url or "").strip() or build_cdn_download_url(
            encrypted_query_param,
            cdn_base_url=self._settings.cdn_base_url,
        )
        client = self._client_for_url(target_url)
        with tempfile.NamedTemporaryFile(
            prefix="bush-weixin-download-",
            suffix=".bin",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        try:
            async with client.stream(
                "GET",
                target_url,
                timeout=httpx.Timeout(
                    max(1.0, float(self._settings.media_timeout_seconds))
                ),
            ) as response:
                response.raise_for_status()
                with temp_path.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        if chunk:
                            handle.write(chunk)
            return temp_path
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise


    async def _upload_cdn_ciphertext_file(
        self,
        *,
        ciphertext_path: Path,
        upload_full_url: str | None,
        upload_param: str | None,
        filekey: str,
    ) -> str:
        ciphertext_size = ciphertext_path.stat().st_size
        if ciphertext_size <= _BUFFERED_CDN_UPLOAD_MAX_BYTES:
            return await self._upload_cdn_ciphertext_bytes(
                ciphertext=ciphertext_path.read_bytes(),
                upload_full_url=upload_full_url,
                upload_param=upload_param,
                filekey=filekey,
            )
        target_url = self._build_cdn_upload_target_url(
            upload_full_url=upload_full_url,
            upload_param=upload_param,
            filekey=filekey,
        )
        client = self._client_for_url(target_url)
        response = await client.request(
            "POST",
            target_url,
            content=self._aiter_file_chunks(ciphertext_path),
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(ciphertext_path.stat().st_size),
            },
            timeout=httpx.Timeout(
                max(1.0, float(self._settings.media_timeout_seconds))
            ),
        )
        return self._parse_cdn_upload_response(response)

    async def _upload_cdn_ciphertext_bytes(
        self,
        *,
        ciphertext: bytes,
        upload_full_url: str | None,
        upload_param: str | None,
        filekey: str,
    ) -> str:
        target_url = self._build_cdn_upload_target_url(
            upload_full_url=upload_full_url,
            upload_param=upload_param,
            filekey=filekey,
        )
        client = self._client_for_url(target_url)
        response = await client.request(
            "POST",
            target_url,
            content=ciphertext,
            headers={
                "Content-Type": "application/octet-stream",
                "Content-Length": str(len(ciphertext)),
            },
            timeout=httpx.Timeout(
                max(1.0, float(self._settings.media_timeout_seconds))
            ),
        )
        return self._parse_cdn_upload_response(response)

    def _build_cdn_upload_target_url(
        self,
        *,
        upload_full_url: str | None,
        upload_param: str | None,
        filekey: str,
    ) -> str:
        target_url = str(upload_full_url or "").strip()
        if target_url:
            return target_url
        normalized_upload_param = str(upload_param or "").strip()
        if not normalized_upload_param:
            raise RuntimeError("CDN upload URL missing (need upload_full_url or upload_param)")
        return build_cdn_upload_url(
            upload_param=normalized_upload_param,
            filekey=filekey,
            cdn_base_url=self._settings.cdn_base_url,
        )

    @staticmethod
    def _parse_cdn_upload_response(response: httpx.Response) -> str:
        if response.status_code != 200:
            error_text = (
                str(response.headers.get("x-error-message") or "").strip()
                or str(response.text or "").strip()
                or f"status {response.status_code}"
            )
            raise RuntimeError(
                f"CDN upload failed ({response.status_code}): {error_text}"
            )
        encrypted_param = str(
            response.headers.get("x-encrypted-param") or ""
        ).strip()
        if not encrypted_param:
            raise RuntimeError("CDN upload response missing x-encrypted-param header")
        return encrypted_param

    async def _request(
        self,
        method: str,
        base_url: str,
        endpoint: str,
        *,
        timeout_seconds: float,
        authenticated: bool,
        token: str | None = None,
        json_body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        url = f"{str(base_url).rstrip('/')}/{endpoint.lstrip('/')}"
        headers = self._build_headers(authenticated=authenticated, token=token)
        client = self._client_for_url(url)
        request_kwargs: dict[str, Any] = {
            "headers": headers,
            "timeout": httpx.Timeout(max(1.0, float(timeout_seconds))),
        }
        if json_body is not None:
            request_kwargs["json"] = json_body
        response = await client.request(
            method.upper(),
            url,
            **request_kwargs,
        )
        response.raise_for_status()
        return response

    def _client_for_url(self, url: str) -> httpx.AsyncClient:
        if self._http_client is not None:
            return self._http_client
        proxy_settings = self._settings.proxy_settings
        if proxy_settings.enabled and not proxy_settings.should_bypass(url):
            if self._owned_proxy_http_client is None:
                self._owned_proxy_http_client = build_httpx_async_client(
                    url,
                    proxy_settings,
                    timeout=httpx.Timeout(
                        max(1.0, float(self._settings.api_timeout_seconds))
                    ),
                )
            return self._owned_proxy_http_client
        if self._owned_http_client is None:
            trust_env = (
                not self._settings.disable_env_proxy
                and not self._settings.proxy_settings.enabled
            )
            self._owned_http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    max(1.0, float(self._settings.api_timeout_seconds))
                ),
                trust_env=trust_env,
            )
        return self._owned_http_client

    @staticmethod
    def _hash_file_md5(file_path: Path, *, chunk_size: int = 1024 * 1024) -> str:
        hasher = hashlib.md5()
        with file_path.open("rb") as handle:
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                hasher.update(chunk)
        return hasher.hexdigest()

    @staticmethod
    def _decrypt_temp_file_to_temp_path(
        *,
        ciphertext_path: Path,
        aes_key: bytes,
    ) -> Path:
        with tempfile.NamedTemporaryFile(
            prefix="bush-weixin-download-dec-",
            suffix=".bin",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        try:
            with ciphertext_path.open("rb") as source, temp_path.open("wb") as target:
                decrypt_aes_ecb_stream(
                    source,
                    target,
                    key=aes_key,
                )
            return temp_path
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _encrypt_file_to_temp_path(
        *,
        plaintext_path: Path,
        aes_key: bytes,
    ) -> Path:
        with tempfile.NamedTemporaryFile(
            prefix="bush-weixin-upload-",
            suffix=".bin",
            delete=False,
        ) as temp_file:
            temp_path = Path(temp_file.name)
        try:
            with plaintext_path.open("rb") as source, temp_path.open("wb") as target:
                encrypt_aes_ecb_stream(
                    source,
                    target,
                    key=aes_key,
                )
            return temp_path
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    async def _aiter_file_chunks(
        file_path: Path,
        *,
        chunk_size: int = 64 * 1024,
    ):
        with file_path.open("rb") as handle:
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    break
                yield chunk

    def _build_headers(
        self,
        *,
        authenticated: bool,
        token: str | None = None,
    ) -> dict[str, str]:
        headers = {
            "iLink-App-Id": self._settings.app_id,
            "iLink-App-ClientVersion": str(self._settings.client_version),
            "X-WECHAT-UIN": self._random_wechat_uin(),
        }
        if self._settings.route_tag:
            headers["SKRouteTag"] = self._settings.route_tag
        if authenticated:
            headers["AuthorizationType"] = "ilink_bot_token"
            if token:
                headers["Authorization"] = f"Bearer {token}"
            headers["Content-Type"] = "application/json"
        return headers

    def _build_base_info(self) -> dict[str, str]:
        return {"channel_version": self._settings.app_version}

    @staticmethod
    def _build_client_id() -> str:
        return f"cardbush-weixin-{random.randint(10**10, 10**11 - 1)}"

    @staticmethod
    def _random_wechat_uin() -> str:
        value = str(random.randint(0, 2**32 - 1)).encode("utf-8")
        return base64.b64encode(value).decode("ascii")

    @staticmethod
    def _load_json(response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                f"invalid weixin response: {response.text}"
            ) from exc
        if not isinstance(payload, dict):
            raise RuntimeError(f"unexpected weixin response: {payload!r}")
        return payload
