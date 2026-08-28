from __future__ import annotations

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey


class DiscordSignatureVerifier:
    def __init__(self, public_key_hex: str) -> None:
        self._verify_key = VerifyKey(bytes.fromhex(public_key_hex))

    def verify(self, *, signature_hex: str, timestamp: str, body: bytes) -> bool:
        try:
            self._verify_key.verify(timestamp.encode("utf-8") + body, bytes.fromhex(signature_hex))
        except (BadSignatureError, ValueError):
            return False
        return True
