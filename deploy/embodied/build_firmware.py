"""Build the pinned audio firmware; no attached device is accessed here."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
PROFILE = json.loads((Path(__file__).parent / 'firmware.json').read_text())

def run(*args, cwd=None):
    subprocess.run(list(map(str, args)), cwd=cwd, check=True)

def replace(file, old, new):
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'Pinned firmware patch mismatch: {file.name}: {old[:70]}')
    file.write_text(text.replace(old, new))

def patch(source):
    replace(source/'main/audio/audio_service.h', '#define OPUS_FRAME_DURATION_MS 60', '#define OPUS_FRAME_DURATION_MS 20')
    replace(source/'main/protocols/protocol.h', '    virtual void SendMcpMessage(const std::string& message);',
            '    virtual void SendMcpMessage(const std::string& message);\n    bool SendDeviceEvent(const std::string& message) { return SendText(message); }')
    app = source / 'main/application.cc'
    replace(app, 'void Application::CheckNewVersion() {', '''void Application::CheckNewVersion() {
    // USB-provisioned CardBush devices never contact the upstream activation/OTA service.
    if (!Settings("websocket", false).GetString("url").empty()) {
        ota_->MarkCurrentVersionValid();
        return;
    }
''')
    replace(app, '    if (ota_->HasMqttConfig()) {', '''    if (!Settings("websocket", false).GetString("url").empty()) {
        protocol_ = std::make_unique<WebsocketProtocol>();
    } else if (ota_->HasMqttConfig()) {''')
    replace(app, '        if (bits & MAIN_EVENT_VAD_CHANGE) {', '''        if (bits & MAIN_EVENT_VAD_CHANGE) {
            if (protocol_ && protocol_->IsAudioChannelOpened()) {
                const bool speaking = audio_service_.IsVoiceDetected();
                protocol_->SendText(speaking
                    ? R"({"type":"cardbush","action":"speech","speaking":true})"
                    : R"({"type":"cardbush","action":"speech","speaking":false})");
                if (speaking && GetDeviceState() == kDeviceStateSpeaking) {
                    audio_service_.ResetDecoder();
                    SetDeviceState(kDeviceStateListening);
                }
            }''')
    replace(app, '                notify_player_.OnPlaybackDrained();', '''                notify_player_.OnPlaybackDrained();
                if (protocol_ && protocol_->IsAudioChannelOpened())
                    protocol_->SendText(R"({"type":"cardbush","action":"playback","speaking":false})");''')
    replace(app, '        } else if (strcmp(type->valuestring, "tts") == 0) {', '''        } else if (strcmp(type->valuestring, "cardbush") == 0) {
            auto action = cJSON_GetObjectItem(root, "action");
            if (cJSON_IsString(action) && strcmp(action->valuestring, "interrupt") == 0) {
                Schedule([this]() {
                    audio_service_.ResetDecoder();
                    SetDeviceState(kDeviceStateListening);
                    if (protocol_) protocol_->SendText(R"({"type":"cardbush","action":"playback","speaking":false})");
                });
            }
        } else if (strcmp(type->valuestring, "tts") == 0) {''')
    replace(app, '                    SetDeviceState(kDeviceStateSpeaking);', '''                    SetDeviceState(kDeviceStateSpeaking);
                    if (protocol_) protocol_->SendText(R"({"type":"cardbush","action":"playback","speaking":true})");''')
    # Establish the first connection automatically after provision. Subsequent reconnects
    # use the existing wake-word/state machine; a failed connection never dispatches work.
    replace(app, '    // Release OTA object after activation is complete', '''    if (!has_error && !Settings("websocket", false).GetString("url").empty()) {
        Schedule([this]() { ToggleChatState(); });
    }
    // Release OTA object after activation is complete''')
    app.write_text(app.read_text().replace('protocol_->SendText(', 'protocol_->SendDeviceEvent('))
    protocol = source / 'main/protocols/websocket_protocol.cc'
    # Context restoration can legitimately exceed the upstream 10-second hello.
    # The host bounds this at 95 seconds; audio does not start before readiness.
    replace(protocol, 'pdFALSE, pdMS_TO_TICKS(10000));', 'pdFALSE, pdMS_TO_TICKS(100000));')
    replace(protocol, '    cJSON_AddBoolToObject(features, "mcp", true);', '    cJSON_AddBoolToObject(features, "mcp", false);\n    cJSON_AddBoolToObject(features, "cardbush", true);')
    cfg = source / 'main/boards/m5stack/atoms3r-echo-base/config.json'
    data = json.loads(cfg.read_text())
    data['builds'][0]['sdkconfig_append'] += ['CONFIG_USE_AUDIO_PROCESSOR=y', 'CONFIG_USE_DEVICE_AEC=y', 'CONFIG_USE_SERVER_AEC=n']
    cfg.write_text(json.dumps(data, indent=2))
    # Atomic Voice Base has a mono ES8311 microphone, not an electrical echo-reference
    # channel. Supply a bounded software playback reference to the existing ESP-SR AFE.
    # Acoustic alignment/quality is an explicit hardware acceptance item.
    kconfig = source/'main/Kconfig.projbuild'
    replace(kconfig, 'depends on USE_AUDIO_PROCESSOR && (BOARD_TYPE_ESP32_S3_BOX_3',
            'depends on USE_AUDIO_PROCESSOR && (BOARD_TYPE_M5STACK_ATOM_S3R_ECHO_BASE || BOARD_TYPE_ESP32_S3_BOX_3')
    header = source/'main/audio/codecs/es8311_audio_codec.h'
    replace(header, '#include <mutex>', '#include <mutex>\n#include <deque>\n#include <vector>')
    replace(header, '    std::mutex data_if_mutex_;', '    std::mutex data_if_mutex_;\n    std::mutex reference_mutex_;\n    std::deque<int16_t> reference_;')
    codec = source/'main/audio/codecs/es8311_audio_codec.cc'
    replace(codec, '    input_reference_ = false;', '    input_reference_ = true;')
    replace(codec, '    input_channels_ = 1;', '    input_channels_ = 2;')
    replace(codec, '''        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_codec_dev_read(dev_, (void*)dest, samples * sizeof(int16_t)));''', '''        std::vector<int16_t> microphone(samples / 2);
        if (esp_codec_dev_read(dev_, microphone.data(), microphone.size() * sizeof(int16_t)) != ESP_OK) return 0;
        std::lock_guard<std::mutex> lock(reference_mutex_);
        for (size_t i = 0; i < microphone.size(); ++i) {
            dest[2*i] = microphone[i];
            dest[2*i+1] = reference_.empty() ? 0 : reference_.front();
            if (!reference_.empty()) reference_.pop_front();
        }''')
    replace(codec, '''        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_codec_dev_write(dev_, (void*)data, samples * sizeof(int16_t)));''', '''        {
            std::lock_guard<std::mutex> lock(reference_mutex_);
            for (int i = 0; i < samples; ++i) reference_.push_back(data[i]);
            while (reference_.size() > static_cast<size_t>(output_sample_rate_ / 5)) reference_.pop_front();
        }
        ESP_ERROR_CHECK_WITHOUT_ABORT(esp_codec_dev_write(dev_, (void*)data, samples * sizeof(int16_t)));''')

def build(source, output):
    if not source.exists():
        run('git', 'clone', PROFILE['upstream'], source)
    current = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if current != PROFILE['commit']:
        run('git', 'fetch', 'origin', PROFILE['commit'], cwd=source)
        run('git', 'checkout', '--detach', PROFILE['commit'], cwd=source)
    stamp = source / '.cardbush-patched'
    recipe_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    if stamp.exists() and stamp.read_text() != recipe_hash:
        # Only files changed by this recipe, inside the dedicated build checkout.
        run('git', 'restore', '--source', PROFILE['commit'], '--', 'main/application.cc',
            'main/protocols/websocket_protocol.cc', 'main/protocols/protocol.h', 'main/boards/m5stack/atoms3r-echo-base/config.json',
            'main/Kconfig.projbuild', 'main/audio/audio_service.h', 'main/audio/codecs/es8311_audio_codec.h', 'main/audio/codecs/es8311_audio_codec.cc', cwd=source)
        stamp.unlink()
    if not stamp.exists():
        patch(source); stamp.write_text(recipe_hash)
    if (output/'dependencies.lock').exists():
        shutil.copy2(output/'dependencies.lock', source/'dependencies.lock')
    run(sys.executable, 'scripts/build.py', PROFILE['upstream_board'], '--language', 'zh-CN', cwd=source)
    config = (source/'sdkconfig').read_text()
    if 'CONFIG_USE_DEVICE_AEC=y' not in config or 'CONFIG_USE_SERVER_AEC=y' in config:
        raise RuntimeError('Firmware must use device AEC, never server AEC.')
    args = json.loads((source/'build/flasher_args.json').read_text())
    output.mkdir(parents=True, exist_ok=True)
    images = []
    for offset, filename in args['flash_files'].items():
        original = source/'build'/filename
        name = f'{int(offset, 16):06x}-{original.name}'
        target = output/name; shutil.copy2(original, target)
        images.append({'offset': int(offset, 16), 'file': name, 'size': target.stat().st_size,
                       'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    manifest = {**PROFILE, 'protocol': 'cardbush.embodied.v1', 'images': images, 'device_aec': True}
    (output/'manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    shutil.copy2(source/'LICENSE', output/'UPSTREAM-LICENSE.txt')
    notices = []
    for tree in [source/'managed_components', Path('/opt/esp/idf')/'components']:
        for file in sorted(tree.glob('*/[Ll][Ii][Cc][Ee][Nn][Ss][Ee]*')):
            if file.is_file() and file.stat().st_size < 100000:
                notices.append(f'\n--- {tree.name}/{file.relative_to(tree)} ---\n'+file.read_text(errors='replace'))
    notices.insert(0, (Path('/opt/esp/idf')/'LICENSE').read_text())
    (output/'THIRD_PARTY_LICENSES.txt').write_text('\n'.join(line.rstrip() for line in '\n'.join(notices).splitlines()).strip()+'\n')
    if (source/'dependencies.lock').exists():
        shutil.copy2(source/'dependencies.lock', output/'dependencies.lock')
    print(json.dumps({'built': True, 'manifest': str(output/'manifest.json')}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inside', action='store_true')
    parser.add_argument('--source', type=Path, default=ROOT/'tmp/embodied-firmware-source')
    parser.add_argument('--output', type=Path, default=ROOT/'assets/skills/embodied-connect/assets/firmware/atoms3r-ai-chatbot')
    options = parser.parse_args()
    if options.inside:
        build(options.source, options.output)
    else:
        # The SDK and compiler live in a pinned container, not in the user's PATH.
        run('docker', 'run', '--rm', '-v', f'{ROOT}:/workspace', '-v', 'cardbush-embodied-build:/build',
            '-w', '/workspace', PROFILE['idf_image'], 'python', 'deploy/embodied/build_firmware.py',
            '--inside', '--source', '/build/xiaozhi')
