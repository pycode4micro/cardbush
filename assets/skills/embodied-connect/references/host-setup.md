# Host and cloud setup

Use the existing running desktop or independent CardBush Agent. A cloud connection owns cloud files/tools, not the user's PC. A desktop assistant can delegate to its already configured remote Agent. The device stores only its own audio-access token.

All examples use `python scripts/device.py` relative to this skill. On a remote host, prepend `--agent-url https://HOST --token-file LOCAL_TOKEN_FILE`; the token file is plain text. On the host itself, use `--control-file DATA_ROOT/embodied/control.json`. That descriptor is local-only and contains a management credential. Do not print or upload it.

1. Read `status`, `assistant-settings`, `voice-settings`. Reuse working configuration.
2. If requested, `assistant-settings --file SETTINGS_JSON` saves a partial host configuration. Supported fields: `modelId` (existing host model ID), `profile` (name, persona, targetAgent, microphoneMuted, outputMuted), `permissionMode`, `subagentPermissionRouting`, `planEnabled`, `language`, `voice`, `disabledTools`, `disabledSkills`. Do not escalate existing permissions for convenience. Independent services do not automatically gain desktop remote-routing connections.
3. `voice-settings --file SETTINGS_JSON` uses the existing realtime settings schema. Read its current shape first, remove read-only `hasApiKey` and `profiles` fields, then update the desired provider/model/endpoint and optionally `apiKey`. Put credentials in the file, never command arguments. `volcengine` uses its existing supported realtime endpoint; `cardbush` requires a server implementing `cardbush.realtime.v1`. Arbitrary text-model endpoints are not compatible.
4. `configure --url wss://voice.example.com/api/embodied/v1/audio` enables the listener, normally on `0.0.0.0:4782`. `--tls-cert` and `--tls-key` accept host-side certificate paths. Alternatively use the existing reverse proxy:

```caddyfile
voice.example.com {
    @audio path /api/embodied/v1/audio
    reverse_proxy @audio 127.0.0.1:4782
    respond 404
}
```

Preserve Authorization, Device-Id, Protocol-Version and WebSocket upgrade. Do not inject a management token, disable TLS verification or expose the local control descriptor. Containers need a port mapping or an internal proxy route. Plain WS is accepted only for private LAN IPs; choose it only on the user's trusted LAN. Use a reachable LAN IP, not localhost, in firmware.

`disable` closes the device listener while retaining pairings. `revoke --device-id ID` disconnects and revokes that device. Changing host settings takes effect on the next device call. One assistant call can be active per host; a desktop call may need to end before the hardware can connect.

The host uses `DATA_ROOT/embodied/devices.json` (token hashes), `assistant.json` (assistant settings) and `control.json` (ephemeral local management). Voice history and provider configuration reuse the existing host files. Independent services protect voice secrets using an AES-GCM key in `DATA_ROOT/config/voice-secret.key`; desktop continues to use OS safeStorage.

Inspect `status`: `connected` is true only after provider readiness; frame counters, first-frame times, `handshakeMs`, interruption counts and a redacted `lastError` help diagnose the link. A rejected configuration or busy assistant should be fixed on the host; never reflash because a voice provider is unavailable. Hardware acoustics and real LAN/cloud latency still require on-device testing.
