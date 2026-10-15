---
name: embodied-connect
description: Install and pair supported voice hardware with CardBush assistant over USB, diagnose device connections, and revoke devices. Supports AtomS3R AI Chatbot Kit; use for hardware setup and voice connectivity, not ordinary voice calls or arbitrary firmware development.
description_zh: 通过 USB 安装、配对和诊断具身语音设备，首款支持 AtomS3R AI Chatbot Kit；用于硬件部署与连接排查，不负责普通语音通话或任意硬件固件开发。
---

# Connect a voice device

Use the bundled `scripts/device.py` helper with an available Python 3.10+ interpreter. If Python is missing, prepare the host's Python environment before installation. The helper calls the running host's device management endpoint and uses the pinned, checksummed firmware in `assets/firmware`. The robot connects to the existing assistant; models, provider credentials, tool permissions and execution host stay on CardBush.

1. Run `python scripts/device.py status` and `python scripts/device.py list`. Resolve paths relative to this skill. The helper automatically installs its pinned USB dependencies into its own cache when USB operations need them.
2. Confirm the physical model is **AtomS3R AI Chatbot Kit (AtomS3R + Atomic Voice Base)**. USB chip identity alone cannot distinguish M5Stack boards. Use the exact serial port from the listing; never guess among multiple devices. An explicit request to install this device authorizes the installation; do not ask again.
3. Reuse the host's configured realtime voice service and assistant settings. The desktop synchronizes its assistant settings; open assistant to check the chosen model and execution host. `status` reports voice configuration. For an independent/cloud host, read [host setup](references/host-setup.md). Never copy a model-provider key into the firmware.
4. Configure the reachable endpoint with `configure --url ws://LAN_IP:4782/api/embodied/v1/audio`. Private LAN WS is supported; public endpoints require WSS. Cloud deployment uses `--agent-url https://HOST --token-file ABSOLUTE_PATH` to manage the selected Agent through its existing authenticated API. See [host setup](references/host-setup.md) for TLS and proxy setup.
5. Obtain Wi-Fi credentials through a local JSON file `{"ssid":"...","password":"..."}`. Do not put passwords or access tokens in shell arguments, logs, chat, or source control. Use the user's chosen network and host. The kit requires 2.4 GHz Wi-Fi.
6. Run `install --port COM7 --wifi-file ABSOLUTE_PATH --backup-dir WORKSPACE/device-backups`. Installation verifies the firmware, detects ESP32-S3/8 MB flash, backs up the original flash, pairs a scoped device identity, writes firmware and network configuration, then observes the handshake. If download mode is required, explain the kit's reset-button procedure; keep the original backup.

Installation success and acoustic verification are distinct. Report the actual receipt: flashed, connected, or awaiting connection. Never claim tested microphone, echo cancellation or latency from compilation or a simulated connection. Ask the user to speak, interrupt playback, dispatch a small task and reconnect; inspect `status` counters and host task history. Software AEC on this kit needs physical tuning.

Use `revoke --device-id ID` before intentionally re-pairing. A disconnect or timeout is not permission to flash again. Reuse the existing device/session and inspect its status. Restore a backup only when requested, with `restore --port COM7 --backup ABSOLUTE_PATH`; this overwrites the selected chip's flash.

Other hardware requires a reviewed board profile and firmware image. Do not select this kit's firmware merely because another device has an ESP32-S3.
