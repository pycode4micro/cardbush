from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

from cardbush_app.paths import ensure_private_directory, secure_private_path


@dataclass(slots=True)
class WeixinAccount:
    account_id: str
    token: str
    base_url: str
    user_id: str | None = None
    saved_at: str | None = None


class WeixinStateStore:
    def __init__(self, root: Path) -> None:
        self._root = root.expanduser().resolve(strict=False)

    @property
    def root(self) -> Path:
        return self._root

    @property
    def accounts_dir(self) -> Path:
        return self.root / "accounts"

    @property
    def account_index_path(self) -> Path:
        return self.root / "accounts.json"

    @property
    def runtime_status_path(self) -> Path:
        return self.root / "runtime-status.json"

    def ensure_directories(self) -> None:
        ensure_private_directory(self.root)
        ensure_private_directory(self.accounts_dir)

    def list_account_ids(self) -> list[str]:
        self.ensure_directories()
        if not self.account_index_path.exists():
            return []
        try:
            raw = json.loads(self.account_index_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return []
        if not isinstance(raw, list):
            return []
        result: list[str] = []
        for item in raw:
            account_id = str(item or "").strip()
            if account_id:
                result.append(account_id)
        return result

    def list_accounts(self) -> list[WeixinAccount]:
        accounts: list[WeixinAccount] = []
        for account_id in self.list_account_ids():
            account = self.load_account(account_id)
            if account is not None:
                accounts.append(account)
        return accounts

    def load_account(self, account_id: str) -> WeixinAccount | None:
        account_path = self._account_path(account_id)
        if not account_path.exists():
            return None
        try:
            raw = json.loads(account_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None
        if not isinstance(raw, dict):
            return None
        token = str(raw.get("token") or "").strip()
        base_url = str(raw.get("base_url") or "").strip()
        normalized_account_id = str(raw.get("account_id") or account_id).strip()
        if not normalized_account_id or not token or not base_url:
            return None
        user_id = str(raw.get("user_id") or "").strip() or None
        saved_at = str(raw.get("saved_at") or "").strip() or None
        return WeixinAccount(
            account_id=normalized_account_id,
            token=token,
            base_url=base_url,
            user_id=user_id,
            saved_at=saved_at,
        )

    def save_account(self, account: WeixinAccount) -> None:
        self.ensure_directories()
        self._write_json(
            self._account_path(account.account_id),
            asdict(account),
        )
        existing = self.list_account_ids()
        if account.account_id not in existing:
            self._write_json(
                self.account_index_path,
                [*existing, account.account_id],
            )

    def remove_account(self, account_id: str) -> None:
        existing = self.list_account_ids()
        if account_id in existing:
            updated = [item for item in existing if item != account_id]
            self._write_json(self.account_index_path, updated)
        for path in (
            self._account_path(account_id),
            self._sync_path(account_id),
            self._context_tokens_path(account_id),
            self._active_sessions_path(account_id),
            self._session_flags_path(account_id),
            self._message_processing_state_path(account_id),
            self._runtime_trace_path(account_id),
        ):
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def remove_accounts_for_user(
        self,
        user_id: str | None,
        *,
        except_account_id: str | None = None,
    ) -> None:
        normalized_user_id = str(user_id or "").strip()
        if not normalized_user_id:
            return
        for account in self.list_accounts():
            if account.account_id == except_account_id:
                continue
            if str(account.user_id or "").strip() == normalized_user_id:
                self.remove_account(account.account_id)

    def clear_all(self) -> None:
        for account_id in self.list_account_ids():
            self.remove_account(account_id)

    def load_sync_buffer(self, account_id: str) -> str:
        path = self._sync_path(account_id)
        if not path.exists():
            return ""
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return ""
        if not isinstance(raw, dict):
            return ""
        return str(raw.get("get_updates_buf") or "")

    def save_sync_buffer(self, account_id: str, sync_buffer: str) -> None:
        self.ensure_directories()
        self._write_json(
            self._sync_path(account_id),
            {"get_updates_buf": str(sync_buffer or "")},
        )

    def clear_sync_buffer(self, account_id: str) -> None:
        try:
            self._sync_path(account_id).unlink()
        except FileNotFoundError:
            pass

    def load_context_tokens(self, account_id: str) -> dict[str, str]:
        path = self._context_tokens_path(account_id)
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if not isinstance(raw, dict):
            return {}
        tokens: dict[str, str] = {}
        for key, value in raw.items():
            user_id = str(key or "").strip()
            token = str(value or "").strip()
            if user_id and token:
                tokens[user_id] = token
        return tokens

    def save_context_tokens(
        self,
        account_id: str,
        tokens: dict[str, str],
    ) -> None:
        filtered = {
            str(key).strip(): str(value).strip()
            for key, value in dict(tokens).items()
            if str(key).strip() and str(value).strip()
        }
        self.ensure_directories()
        self._write_json(self._context_tokens_path(account_id), filtered)

    def set_context_token(
        self,
        account_id: str,
        user_id: str,
        context_token: str,
    ) -> None:
        normalized_user_id = str(user_id or "").strip()
        normalized_token = str(context_token or "").strip()
        if not normalized_user_id or not normalized_token:
            return
        tokens = self.load_context_tokens(account_id)
        tokens[normalized_user_id] = normalized_token
        self.save_context_tokens(account_id, tokens)

    def get_context_token(self, account_id: str, user_id: str) -> str | None:
        return self.load_context_tokens(account_id).get(str(user_id or "").strip())

    def load_active_session_ids(self, account_id: str) -> dict[str, str]:
        path = self._active_sessions_path(account_id)
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if not isinstance(raw, dict):
            return {}
        session_ids: dict[str, str] = {}
        for key, value in raw.items():
            user_id = str(key or "").strip()
            session_id = str(value or "").strip()
            if user_id and session_id:
                session_ids[user_id] = session_id
        return session_ids

    def save_active_session_ids(
        self,
        account_id: str,
        session_ids: dict[str, str],
    ) -> None:
        filtered = {
            str(key).strip(): str(value).strip()
            for key, value in dict(session_ids).items()
            if str(key).strip() and str(value).strip()
        }
        self.ensure_directories()
        self._write_json(self._active_sessions_path(account_id), filtered)

    def set_active_session_id(
        self,
        account_id: str,
        user_id: str,
        session_id: str,
    ) -> None:
        normalized_user_id = str(user_id or "").strip()
        normalized_session_id = str(session_id or "").strip()
        if not normalized_user_id or not normalized_session_id:
            return
        session_ids = self.load_active_session_ids(account_id)
        session_ids[normalized_user_id] = normalized_session_id
        self.save_active_session_ids(account_id, session_ids)

    def get_active_session_id(self, account_id: str, user_id: str) -> str | None:
        return self.load_active_session_ids(account_id).get(str(user_id or "").strip())

    def load_session_flags(self, account_id: str) -> dict[str, dict[str, bool]]:
        path = self._session_flags_path(account_id)
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if not isinstance(raw, dict):
            return {}
        result: dict[str, dict[str, bool]] = {}
        for raw_session_id, raw_flags in raw.items():
            session_id = str(raw_session_id or "").strip()
            if not session_id or not isinstance(raw_flags, dict):
                continue
            normalized_flags: dict[str, bool] = {}
            for raw_key, raw_value in raw_flags.items():
                key = str(raw_key or "").strip()
                if not key:
                    continue
                normalized_flags[key] = bool(raw_value)
            if normalized_flags:
                result[session_id] = normalized_flags
        return result

    def save_session_flags(
        self,
        account_id: str,
        session_flags: dict[str, dict[str, bool]],
    ) -> None:
        normalized: dict[str, dict[str, bool]] = {}
        for raw_session_id, raw_flags in dict(session_flags).items():
            session_id = str(raw_session_id or "").strip()
            if not session_id or not isinstance(raw_flags, dict):
                continue
            flags = {
                str(key).strip(): bool(value)
                for key, value in raw_flags.items()
                if str(key).strip()
            }
            if flags:
                normalized[session_id] = flags
        self.ensure_directories()
        self._write_json(self._session_flags_path(account_id), normalized)

    def set_session_flag(
        self,
        account_id: str,
        session_id: str,
        *,
        key: str,
        enabled: bool,
    ) -> None:
        normalized_session_id = str(session_id or "").strip()
        normalized_key = str(key or "").strip()
        if not normalized_session_id or not normalized_key:
            return
        payload = self.load_session_flags(account_id)
        session_flags = dict(payload.get(normalized_session_id) or {})
        session_flags[normalized_key] = bool(enabled)
        payload[normalized_session_id] = session_flags
        self.save_session_flags(account_id, payload)

    def get_session_flag(
        self,
        account_id: str,
        session_id: str,
        *,
        key: str,
    ) -> bool:
        normalized_session_id = str(session_id or "").strip()
        normalized_key = str(key or "").strip()
        if not normalized_session_id or not normalized_key:
            return False
        payload = self.load_session_flags(account_id)
        session_flags = payload.get(normalized_session_id)
        if not isinstance(session_flags, dict):
            return False
        return bool(session_flags.get(normalized_key))

    def clear_runtime_state(self, account_id: str) -> None:
        for path in (
            self._sync_path(account_id),
            self._context_tokens_path(account_id),
            self._active_sessions_path(account_id),
            self._session_flags_path(account_id),
            self._message_processing_state_path(account_id),
            self._runtime_trace_path(account_id),
        ):
            try:
                path.unlink()
            except FileNotFoundError:
                pass

    def load_message_processing_state(self, account_id: str) -> dict[str, dict[str, float | int]]:
        path = self._message_processing_state_path(account_id)
        if not path.exists():
            return {"handled": {}, "failures": {}}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"handled": {}, "failures": {}}
        if not isinstance(raw, dict):
            return {"handled": {}, "failures": {}}
        handled_raw = raw.get("handled")
        failures_raw = raw.get("failures")
        handled: dict[str, float] = {}
        failures: dict[str, int] = {}
        if isinstance(handled_raw, dict):
            for key, value in handled_raw.items():
                message_id = str(key or "").strip()
                if not message_id:
                    continue
                try:
                    handled[message_id] = float(value)
                except (TypeError, ValueError):
                    continue
        if isinstance(failures_raw, dict):
            for key, value in failures_raw.items():
                message_id = str(key or "").strip()
                if not message_id:
                    continue
                try:
                    failures[message_id] = int(value)
                except (TypeError, ValueError):
                    continue
        return {"handled": handled, "failures": failures}

    def save_message_processing_state(
        self,
        account_id: str,
        *,
        handled: dict[str, float],
        failures: dict[str, int],
    ) -> None:
        normalized_handled = {
            str(key).strip(): float(value)
            for key, value in dict(handled).items()
            if str(key).strip()
        }
        normalized_failures = {
            str(key).strip(): int(value)
            for key, value in dict(failures).items()
            if str(key).strip() and int(value) > 0
        }
        self.ensure_directories()
        self._write_json(
            self._message_processing_state_path(account_id),
            {
                "handled": normalized_handled,
                "failures": normalized_failures,
            },
        )

    def load_runtime_trace(self, account_id: str) -> dict[str, object]:
        path = self._runtime_trace_path(account_id)
        if not path.exists():
            return {}
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        if not isinstance(raw, dict):
            return {}
        return dict(raw)

    def save_runtime_trace(
        self,
        account_id: str,
        payload: dict[str, object],
    ) -> None:
        self.ensure_directories()
        self._write_json(self._runtime_trace_path(account_id), dict(payload))

    def save_runtime_status(self, payload: dict[str, object]) -> None:
        self.ensure_directories()
        self._write_json(self.runtime_status_path, dict(payload))

    def _account_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.json"

    def _sync_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.sync.json"

    def _context_tokens_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.context-tokens.json"

    def _active_sessions_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.active-sessions.json"

    def _session_flags_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.session-flags.json"

    def _runtime_trace_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.runtime-trace.json"

    def _message_processing_state_path(self, account_id: str) -> Path:
        return self.accounts_dir / f"{account_id}.message-processing.json"

    @staticmethod
    def _write_json(path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        secure_private_path(path, is_dir=False)
