from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from .config import FeishuBotSettings

logger = logging.getLogger(__name__)


class FeishuMessageClient:
    def __init__(self, settings: FeishuBotSettings, http_client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._http_client = http_client
        self._owned_http_client: httpx.AsyncClient | None = None
        self._token: str | None = None
        self._token_expire_at = 0.0

    def _client(self) -> httpx.AsyncClient:
        if self._http_client is not None:
            return self._http_client
        if self._owned_http_client is None:
            self._owned_http_client = httpx.AsyncClient(
                timeout=15.0,
                trust_env=not self._settings.disable_env_proxy,
            )
        return self._owned_http_client

    async def send_text(self, *, chat_id: str, text: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages",
            params={"receive_id_type": "chat_id"},
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu send message failed: {data}")
        return data

    async def send_file(self, *, chat_id: str, file_key: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "receive_id": chat_id,
            "msg_type": "file",
            "content": json.dumps({"file_key": file_key}, ensure_ascii=False),
        }
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages",
            params={"receive_id_type": "chat_id"},
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu send file message failed: {data}")
        return data

    async def send_image(self, *, chat_id: str, image_key: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "receive_id": chat_id,
            "msg_type": "image",
            "content": json.dumps({"image_key": image_key}, ensure_ascii=False),
        }
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages",
            params={"receive_id_type": "chat_id"},
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu send image message failed: {data}")
        return data

    async def reply_text(self, *, message_id: str, text: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
        logger.info(
            "Feishu reply request: message_id=%s payload=%s",
            message_id,
            payload,
        )
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages/{message_id}/reply",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        logger.info(
            "Feishu reply response: message_id=%s response=%s",
            message_id,
            data,
        )
        if int(data.get("code", 0)) != 0:
            logger.warning(
                "Feishu reply failed: message_id=%s response=%s",
                message_id,
                data,
            )
            raise RuntimeError(f"Feishu reply failed: {data}")
        return data

    async def reply_file(self, *, message_id: str, file_key: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "msg_type": "file",
            "content": json.dumps({"file_key": file_key}, ensure_ascii=False),
        }
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages/{message_id}/reply",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu reply file failed: {data}")
        return data

    async def reply_image(self, *, message_id: str, image_key: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "msg_type": "image",
            "content": json.dumps({"image_key": image_key}, ensure_ascii=False),
        }
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages/{message_id}/reply",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu reply image failed: {data}")
        return data

    async def add_reaction(self, *, message_id: str, emoji_type: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "reaction_type": {
                "emoji_type": emoji_type,
            }
        }
        logger.info(
            "Feishu reaction request: message_id=%s payload=%s",
            message_id,
            payload,
        )
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/messages/{message_id}/reactions",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        logger.info(
            "Feishu reaction response: message_id=%s response=%s",
            message_id,
            data,
        )
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu reaction failed: {data}")
        return data

    async def update_text(self, *, message_id: str, text: str) -> dict[str, Any]:
        token = await self._tenant_access_token()
        payload = {
            "msg_type": "text",
            "content": json.dumps({"text": text}, ensure_ascii=False),
        }
        logger.info(
            "Feishu update request: message_id=%s payload=%s",
            message_id,
            payload,
        )
        response = await self._client().put(
            f"{self._settings.api_base}/open-apis/im/v1/messages/{message_id}",
            headers={"Authorization": f"Bearer {token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        logger.info(
            "Feishu update response: message_id=%s response=%s",
            message_id,
            data,
        )
        if int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu update failed: {data}")
        return data

    async def download_message_resource(
        self,
        *,
        message_id: str,
        file_key: str,
        resource_type: str = "file",
    ) -> bytes:
        token = await self._tenant_access_token()
        response = await self._client().get(
            f"{self._settings.api_base}/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
            params={"type": resource_type},
            headers={"Authorization": f"Bearer {token}"},
        )
        try:
            response.raise_for_status()
        except Exception as exc:
            status_code = getattr(response, "status_code", "unknown")
            response_text = str(getattr(response, "text", "") or "")
            raise RuntimeError(
                "Feishu download resource http error: "
                f"message_id={message_id} file_key={file_key} status_code={status_code} body={response_text[:512]}"
            ) from exc
        headers = getattr(response, "headers", None) or {}
        content_type = str(headers.get("content-type", "") or "").lower()
        if "application/json" in content_type:
            payload: dict[str, Any] | None = None
            with_json = getattr(response, "json", None)
            if callable(with_json):
                try:
                    parsed = with_json()
                except Exception:  # noqa: BLE001
                    parsed = None
                if isinstance(parsed, dict):
                    payload = parsed
            if payload is not None and int(payload.get("code", 0) or 0) != 0:
                raise RuntimeError(
                    "Feishu download resource api error: "
                    f"message_id={message_id} file_key={file_key} payload={payload}"
                )
        if not response.content:
            raise RuntimeError(
                "Feishu download resource returned empty content: "
                f"message_id={message_id} file_key={file_key} resource_type={resource_type}"
            )
        return response.content

    async def download_message_resource_to_path(
        self,
        *,
        message_id: str,
        file_key: str,
        target_path: str | Path,
        resource_type: str = "file",
    ) -> int:
        token = await self._tenant_access_token()
        destination = Path(target_path).expanduser()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temp_path = destination.with_name(f"{destination.name}.downloading")
        url = (
            f"{self._settings.api_base}/open-apis/im/v1/messages/"
            f"{message_id}/resources/{file_key}"
        )
        async with self._client().stream(
            "GET",
            url,
            params={"type": resource_type},
            headers={"Authorization": f"Bearer {token}"},
        ) as response:
            try:
                response.raise_for_status()
            except Exception as exc:
                status_code = getattr(response, "status_code", "unknown")
                response_text = str(await response.aread() or b"")[:512]
                raise RuntimeError(
                    "Feishu download resource http error: "
                    f"message_id={message_id} file_key={file_key} status_code={status_code} body={response_text}"
                ) from exc
            headers = getattr(response, "headers", None) or {}
            content_type = str(headers.get("content-type", "") or "").lower()
            if "application/json" in content_type:
                raw_body = await response.aread()
                payload: dict[str, Any] | None = None
                try:
                    parsed = json.loads(raw_body)
                except Exception:  # noqa: BLE001
                    parsed = None
                if isinstance(parsed, dict):
                    payload = parsed
                if payload is not None and int(payload.get("code", 0) or 0) != 0:
                    raise RuntimeError(
                        "Feishu download resource api error: "
                        f"message_id={message_id} file_key={file_key} payload={payload}"
                    )
                raise RuntimeError(
                    "Feishu download resource returned JSON instead of binary: "
                    f"message_id={message_id} file_key={file_key} resource_type={resource_type}"
                )
            bytes_written = 0
            try:
                with temp_path.open("wb") as handle:
                    async for chunk in response.aiter_bytes():
                        if not chunk:
                            continue
                        handle.write(chunk)
                        bytes_written += len(chunk)
                if bytes_written <= 0:
                    raise RuntimeError(
                        "Feishu download resource returned empty content: "
                        f"message_id={message_id} file_key={file_key} resource_type={resource_type}"
                    )
                temp_path.replace(destination)
                return bytes_written
            except Exception:
                try:
                    temp_path.unlink(missing_ok=True)
                except Exception:  # noqa: BLE001
                    pass
                raise

    async def download_image_resource(
        self,
        *,
        message_id: str,
        image_key: str,
    ) -> bytes:
        return await self.download_message_resource(
            message_id=message_id,
            file_key=image_key,
            resource_type="image",
        )

    async def upload_file(
        self,
        *,
        file_name: str,
        file_content: bytes,
        file_type: str = "stream",
        duration_ms: int | None = None,
    ) -> str:
        token = await self._tenant_access_token()
        data: dict[str, str] = {
            "file_type": file_type,
            "file_name": file_name,
        }
        if duration_ms is not None:
            data["duration"] = str(int(duration_ms))
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/files",
            headers={"Authorization": f"Bearer {token}"},
            data=data,
            files={"file": (file_name, file_content)},
        )
        response.raise_for_status()
        payload = response.json()
        if int(payload.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu upload file failed: {payload}")
        node = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        file_key = str(node.get("file_key", "") or "").strip()
        if not file_key:
            raise RuntimeError(f"Feishu upload file returned empty file_key: {payload}")
        return file_key

    async def upload_image(
        self,
        *,
        image_name: str,
        image_content: bytes,
        image_type: str = "message",
    ) -> str:
        token = await self._tenant_access_token()
        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/im/v1/images",
            headers={"Authorization": f"Bearer {token}"},
            data={"image_type": image_type},
            files={"image": (image_name, image_content)},
        )
        response.raise_for_status()
        payload = response.json()
        if int(payload.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu upload image failed: {payload}")
        node = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        image_key = str(node.get("image_key", "") or "").strip()
        if not image_key:
            raise RuntimeError(f"Feishu upload image returned empty image_key: {payload}")
        return image_key

    async def upload_file_from_path(
        self,
        *,
        file_path: str,
        file_type: str = "stream",
        duration_ms: int | None = None,
    ) -> str:
        path = Path(file_path).expanduser()
        token = await self._tenant_access_token()
        data: dict[str, str] = {
            "file_type": file_type,
            "file_name": path.name,
        }
        if duration_ms is not None:
            data["duration"] = str(int(duration_ms))
        with path.open("rb") as file_handle:
            response = await self._client().post(
                f"{self._settings.api_base}/open-apis/im/v1/files",
                headers={"Authorization": f"Bearer {token}"},
                data=data,
                files={"file": (path.name, file_handle)},
            )
        response.raise_for_status()
        payload = response.json()
        if int(payload.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu upload file failed: {payload}")
        node = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        file_key = str(node.get("file_key", "") or "").strip()
        if not file_key:
            raise RuntimeError(f"Feishu upload file returned empty file_key: {payload}")
        return file_key

    async def send_file_from_path(
        self,
        *,
        chat_id: str,
        file_path: str,
        file_type: str = "stream",
        duration_ms: int | None = None,
    ) -> dict[str, Any]:
        file_key = await self.upload_file_from_path(
            file_path=file_path,
            file_type=file_type,
            duration_ms=duration_ms,
        )
        return await self.send_file(chat_id=chat_id, file_key=file_key)

    async def upload_image_from_path(
        self,
        *,
        image_path: str,
        image_type: str = "message",
    ) -> str:
        path = Path(image_path).expanduser()
        token = await self._tenant_access_token()
        with path.open("rb") as image_handle:
            response = await self._client().post(
                f"{self._settings.api_base}/open-apis/im/v1/images",
                headers={"Authorization": f"Bearer {token}"},
                data={"image_type": image_type},
                files={"image": (path.name, image_handle)},
            )
        response.raise_for_status()
        payload = response.json()
        if int(payload.get("code", 0)) != 0:
            raise RuntimeError(f"Feishu upload image failed: {payload}")
        node = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        image_key = str(node.get("image_key", "") or "").strip()
        if not image_key:
            raise RuntimeError(f"Feishu upload image returned empty image_key: {payload}")
        return image_key

    async def send_image_from_path(
        self,
        *,
        chat_id: str,
        image_path: str,
        image_type: str = "message",
    ) -> dict[str, Any]:
        image_key = await self.upload_image_from_path(
            image_path=image_path,
            image_type=image_type,
        )
        return await self.send_image(chat_id=chat_id, image_key=image_key)

    async def _tenant_access_token(self) -> str:
        now = time.time()
        if self._token and now < self._token_expire_at:
            return self._token

        response = await self._client().post(
            f"{self._settings.api_base}/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": self._settings.app_id, "app_secret": self._settings.app_secret},
        )
        response.raise_for_status()
        data = response.json()
        token = str(data.get("tenant_access_token", "") or "").strip()
        expire = int(data.get("expire", 0) or 0)
        if not token or int(data.get("code", 0)) != 0:
            raise RuntimeError(f"Failed to fetch Feishu tenant access token: {data}")
        self._token = token
        self._token_expire_at = now + max(60, expire - 60)
        return token

    async def aclose(self) -> None:
        self._token = None
        self._token_expire_at = 0.0
        client = self._owned_http_client
        self._owned_http_client = None
        if client is not None:
            await client.aclose()
