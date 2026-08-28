from __future__ import annotations

from typing import Any

import httpx

from .config import DiscordBotSettings


class DiscordCommandClient:
    def __init__(self, settings: DiscordBotSettings, http_client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._http_client = http_client
        self._owned_http_client: httpx.AsyncClient | None = None

    def _client(self) -> httpx.AsyncClient:
        if self._http_client is not None:
            return self._http_client
        if self._owned_http_client is None:
            self._owned_http_client = httpx.AsyncClient(timeout=15.0)
        return self._owned_http_client

    async def sync_chat_command(self) -> list[dict[str, Any]]:
        payload = [
            {
                "name": self._settings.command_name,
                "description": "Send a chat message to the configured conversation backend",
                "type": 1,
                "options": [
                    {
                        "type": 3,
                        "name": "message",
                        "description": "Message content",
                        "required": True,
                    }
                ],
                "contexts": [0, 1, 2],
                "integration_types": [0, 1],
            }
        ]
        if self._settings.guild_id:
            url = (
                f"{self._settings.api_base}/applications/{self._settings.application_id}"
                f"/guilds/{self._settings.guild_id}/commands"
            )
        else:
            url = f"{self._settings.api_base}/applications/{self._settings.application_id}/commands"
        response = await self._client().put(
            url,
            headers={"Authorization": f"Bot {self._settings.bot_token}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, list):
            raise RuntimeError(f"Discord command sync failed: {data}")
        return data

    async def aclose(self) -> None:
        client = self._owned_http_client
        self._owned_http_client = None
        if client is not None:
            await client.aclose()


class DiscordMessageClient:
    def __init__(self, settings: DiscordBotSettings, http_client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._http_client = http_client
        self._owned_http_client: httpx.AsyncClient | None = None

    def _client(self) -> httpx.AsyncClient:
        if self._http_client is not None:
            return self._http_client
        if self._owned_http_client is None:
            self._owned_http_client = httpx.AsyncClient(timeout=15.0)
        return self._owned_http_client

    async def send_text(self, *, channel_id: str, text: str, reply_to_message_id: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"content": text}
        if reply_to_message_id:
            payload["message_reference"] = {"message_id": reply_to_message_id}
            payload["allowed_mentions"] = {"replied_user": False}
        response = await self._client().post(
            f"{self._settings.api_base}/channels/{channel_id}/messages",
            headers={
                "Authorization": f"Bot {self._settings.bot_token}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            raise RuntimeError(f"Discord send message failed: {data}")
        return data

    async def aclose(self) -> None:
        client = self._owned_http_client
        self._owned_http_client = None
        if client is not None:
            await client.aclose()
