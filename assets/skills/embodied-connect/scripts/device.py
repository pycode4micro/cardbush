"""CardBush USB installer. Secrets are read from files, never command arguments."""
from pathlib import Path
import argparse
import csv
import hashlib
import importlib.util
import importlib.metadata
import ipaddress
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

SKILL = Path(__file__).resolve().parents[1]
BOARD = 'atoms3r-ai-chatbot'
DEPENDENCIES = ['esptool==5.5.0', 'esp-idf-nvs-partition-gen==0.3.0', 'pyserial==3.5']

def emit(phase, **data):
    print(json.dumps({'phase': phase, **data}, ensure_ascii=False), flush=True)

def default_control():
    if os.getenv('CARDBUSH_EMBODIED_CONTROL_FILE'):
        return Path(os.environ['CARDBUSH_EMBODIED_CONTROL_FILE'])
    if os.getenv('CARDBUSH_RUNTIME_STATE_ROOT'):
        return Path(os.environ['CARDBUSH_RUNTIME_STATE_ROOT']).parent/'embodied/control.json'
    if sys.platform == 'win32':
        return Path(os.environ['APPDATA'])/'cardbush/embodied/control.json'
    if sys.platform == 'darwin':
        return Path.home()/'Library/Application Support/cardbush/embodied/control.json'
    return Path(os.getenv('XDG_CONFIG_HOME', Path.home()/'.config'))/'cardbush/embodied/control.json'

def dependencies():
    try:
        if all(importlib.metadata.version(name) == version for name,version in (item.split('==') for item in DEPENDENCIES)):
            return
    except importlib.metadata.PackageNotFoundError:
        pass
    cache = Path(os.getenv('LOCALAPPDATA', str(Path.home()/'.cache')))/'cardbush/device-installer-v1'
    python = cache/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if Path(sys.prefix).resolve() == cache.resolve():
        raise RuntimeError('USB dependencies are missing from the installer environment.')
    emit('dependencies', directory=str(cache))
    if not python.exists():
        subprocess.run([sys.executable, '-m', 'venv', str(cache)], check=True)
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', *DEPENDENCIES], check=True, stdout=sys.stderr)
    os.execv(str(python), [str(python), str(Path(__file__).resolve()), *sys.argv[1:]])

def endpoint(value):
    url = urlparse(value)
    private = url.hostname == 'localhost'
    try:
        address = ipaddress.ip_address(url.hostname or '')
        private = address.is_loopback or any(address in network for network in
            [ipaddress.ip_network('10.0.0.0/8'), ipaddress.ip_network('172.16.0.0/12'), ipaddress.ip_network('192.168.0.0/16')])
    except ValueError:
        pass
    if url.scheme != 'wss' and not (url.scheme == 'ws' and private) or url.username or url.password or url.query or url.fragment or url.path != '/api/embodied/v1/audio':
        raise ValueError('Use WSS, or WS with a private LAN IP, and /api/embodied/v1/audio.')
    return value

def call(options, action, value=None):
    payload = {'action': action, **({'input': value} if value is not None else {})}
    if options.agent_url:
        if not options.token_file:
            raise ValueError('--token-file is required for a cloud/independent Agent.')
        parsed = urlparse(options.agent_url)
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ['127.0.0.1', 'localhost', '::1']):
            raise ValueError('Agent management requires HTTPS or a local tunnel.')
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError('Credentials must be in --token-file.')
        url = options.agent_url.rstrip('/')+'/api/agent/v1/call'
        token = options.token_file.read_text(encoding='utf-8').strip()
        payload = {'operation': 'devices.command', 'input': payload}
    else:
        info = json.loads(options.control_file.read_text(encoding='utf-8'))
        url, token = info['url'], info['token']
        if urlparse(url).hostname != '127.0.0.1' or urlparse(url).scheme != 'http':
            raise ValueError('The local management descriptor must use loopback.')
    request = urllib.request.Request(url, json.dumps(payload).encode(), {'Content-Type': 'application/json', 'Authorization': 'Bearer '+token}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
            return json.load(response)['result']
    except urllib.error.HTTPError as error:
        # Do not echo arbitrary network bodies, URLs, or authentication material.
        raise RuntimeError(f'Host rejected {action} (HTTP {error.code}); inspect host settings/status.') from None

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A management credential must never follow a redirect to another host.
        return None

def manifest(directory):
    data = json.loads((directory/'manifest.json').read_text(encoding='utf-8'))
    if data.get('board') != BOARD or data.get('chip') != 'esp32s3' or data.get('flash_bytes') != 8388608:
        raise ValueError('Unsupported firmware profile.')
    if data.get('nvs_offset') != 0x9000 or data.get('nvs_bytes') != 0x4000 or not data.get('images'):
        raise ValueError('Unsupported firmware partition layout.')
    spans = [(0x9000, 0xd000)]
    for entry in data['images']:
        name = entry['file']; file = directory/name
        if Path(name).name != name or file.resolve().parent != directory.resolve():
            raise ValueError('Firmware path escapes its package.')
        raw = file.read_bytes()
        if len(raw) != entry['size'] or hashlib.sha256(raw).hexdigest() != entry['sha256']:
            raise ValueError('Firmware integrity check failed.')
        start, end = entry['offset'], entry['offset']+len(raw)
        if not isinstance(start, int) or start < 0 or end > data['flash_bytes'] or any(start < b and end > a for a,b in spans):
            raise ValueError('Firmware partitions overlap or exceed the flash.')
        spans.append((start, end))
    return data

def esptool(port, *args):
    result = subprocess.run([sys.executable, '-m', 'esptool', '--chip', 'esp32s3', '--port', port, *map(str,args)], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if result.returncode:
        # Esptool command output contains serial diagnostics, not provisioning payloads.
        sys.stderr.write(result.stdout[-4000:]+result.stderr[-2000:])
        raise RuntimeError('USB command failed. Check the selected port, data cable and download mode.')
    return result.stdout

def identify(port):
    text = esptool(port, 'read-mac')
    match = re.search(r'MAC:\s*([a-fA-F0-9]{2}(?::[a-fA-F0-9]{2}){5})', text)
    if not match:
        raise RuntimeError('Could not identify the ESP32-S3 MAC; no flash was written.')
    flash = esptool(port, 'flash-id')
    if not re.search(r'(?:flash size|Flash size):\s*8\s*MB', flash, re.I):
        raise RuntimeError('Expected an ESP32-S3 with 8 MB flash; no flash was written.')
    return match.group(1).lower()

def create_nvs(target, wifi, url, token):
    from esp_idf_nvs_partition_gen import nvs_partition_gen
    csv_file = target.with_suffix('.csv')
    with csv_file.open('w', newline='', encoding='utf-8') as stream:
        writer = csv.writer(stream)
        writer.writerows([['key','type','encoding','value'], ['wifi','namespace','',''],
            ['ssid','data','string',wifi['ssid']], ['password','data','string',wifi['password']],
            ['websocket','namespace','',''], ['url','data','string',url], ['token','data','string',token], ['version','data','i32',1],
            ['audio','namespace','',''], ['output_volume','data','i32',45]])
    os.chmod(csv_file, 0o600)
    try:
        args = argparse.Namespace(input=str(csv_file), output=str(target), size=hex(0x4000), version=2, outdir=str(target.parent))
        nvs_partition_gen.generate(args)
        os.chmod(target, 0o600)
    finally:
        csv_file.unlink(missing_ok=True)

def install(options):
    firmware = options.firmware.resolve(); data = manifest(firmware)
    wifi = json.loads(options.wifi_file.read_text(encoding='utf-8'))
    if not isinstance(wifi.get('ssid'), str) or not 1 <= len(wifi['ssid'].encode()) <= 32 or not isinstance(wifi.get('password'), str) or len(wifi['password'].encode()) > 63 or '\0' in wifi['ssid']+wifi['password']:
        raise ValueError('Invalid Wi-Fi configuration file.')
    state = call(options, 'status')
    if not state.get('listening'):
        raise RuntimeError('Configure and enable the device listener before installation.')
    url = endpoint(state['listener']['publicUrl'])
    if state['voice']['mode'] != 'realtime' or (state['voice']['provider'] == 'volcengine' and not state['voice']['hasApiKey']):
        raise RuntimeError('Configure realtime voice on the host before installation.')
    dependencies()
    device_id = identify(options.port)
    if any(d['id'] == device_id and not d['revoked'] for d in state['paired']):
        raise RuntimeError('This device is already paired. Inspect status; revoke explicitly before reinstalling.')
    options.backup_dir.mkdir(parents=True, exist_ok=True)
    backup = options.backup_dir/(device_id.replace(':','-')+'-'+str(time.time_ns())+'.bin')
    emit('backup', device_id=device_id, path=str(backup))
    esptool(options.port, 'read-flash', '0', hex(data['flash_bytes']), backup)
    os.chmod(backup, 0o600)
    if backup.stat().st_size != data['flash_bytes']:
        raise RuntimeError('Incomplete original flash backup; installation stopped.')
    receipt = {'board': BOARD, 'deviceId': device_id, 'backup': str(backup.resolve()), 'backupSha256': hashlib.sha256(backup.read_bytes()).hexdigest(),
               'firmwareCommit': data['commit'], 'flashed': False, 'connected': False}
    receipt_file = backup.with_suffix('.json')
    receipt_file.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    paired = call(options, 'pair', {'id': device_id, 'name': options.name, 'board': BOARD})
    try:
        with tempfile.TemporaryDirectory(prefix='cardbush-provision-') as temporary:
            nvs = Path(temporary)/'nvs.bin'; create_nvs(nvs, wifi, url, paired['token'])
            del paired['token']
            args = ['write-flash']
            for image in sorted(data['images'], key=lambda item:item['offset']):
                args.extend([hex(image['offset']), str(firmware/image['file'])])
            args.extend([hex(data['nvs_offset']), str(nvs)])
            emit('flashing', device_id=device_id)
            esptool(options.port, *args)
            receipt['flashed'] = True
    except BaseException:
        try:
            call(options, 'revoke', {'id':device_id})
        except Exception:
            emit('revoke-required', device_id=device_id)
        raise
    finally:
        receipt_file.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    emit('connecting', device_id=device_id)
    deadline = time.monotonic()+options.wait
    while time.monotonic() < deadline:
        try:
            status = call(options, 'status').get('devices',{}).get(device_id,{})
            if status.get('connected'):
                receipt['connected'] = True
                break
        except (OSError, RuntimeError):
            pass
        time.sleep(2)
    receipt_file.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    emit('connected' if receipt['connected'] else 'awaiting-connection', **receipt, receipt=str(receipt_file.resolve()),
         acousticTest='pending: speak, interrupt, delegate a task, and reconnect')
    return 0 if receipt['connected'] else 2

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control-file', type=Path, default=default_control())
    parser.add_argument('--agent-url'); parser.add_argument('--token-file', type=Path)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('status'); commands.add_parser('list')
    for kind in ['voice-settings', 'assistant-settings']:
        settings = commands.add_parser(kind)
        settings.add_argument('--file', type=Path, help='Host settings JSON; omitted to read redacted settings.')
    commands.add_parser('disable')
    config = commands.add_parser('configure')
    config.add_argument('--url', required=True); config.add_argument('--port', type=int, default=4782)
    config.add_argument('--tls-cert', default=''); config.add_argument('--tls-key', default='')
    revoke = commands.add_parser('revoke'); revoke.add_argument('--device-id', required=True)
    setup = commands.add_parser('install')
    setup.add_argument('--port', required=True); setup.add_argument('--wifi-file', type=Path, required=True)
    setup.add_argument('--backup-dir', type=Path, default=Path.cwd()/'device-backups')
    setup.add_argument('--firmware', type=Path, default=SKILL/'assets/firmware'/BOARD)
    setup.add_argument('--name', default='AtomS3R AI Chatbot Kit'); setup.add_argument('--wait', type=int, default=120)
    restore = commands.add_parser('restore'); restore.add_argument('--port', required=True); restore.add_argument('--backup', type=Path, required=True)
    options = parser.parse_args()
    if options.action == 'install':
        return install(options)
    if options.action == 'list':
        dependencies()
        from serial.tools import list_ports
        emit('devices', ports=[{'port':p.device,'description':p.description,'vid':p.vid,'pid':p.pid} for p in list_ports.comports()])
    elif options.action == 'configure':
        emit('configured', result=call(options, 'configure', {'enabled':True,'host':'0.0.0.0','port':options.port,
            'publicUrl':endpoint(options.url),'tlsCert':options.tls_cert,'tlsKey':options.tls_key}))
    elif options.action == 'revoke':
        emit('revoked', result=call(options, 'revoke', {'id':options.device_id}))
    elif options.action in ['voice-settings', 'assistant-settings']:
        kind = options.action.split('-')[0]
        result = call(options, kind+'.save', json.loads(options.file.read_text(encoding='utf-8'))) if options.file else call(options, kind+'.get')
        emit('settings', result=result)
    elif options.action == 'disable':
        current = call(options, 'status')['listener']; current['enabled'] = False
        emit('disabled', result=call(options, 'configure', current))
    elif options.action == 'restore':
        dependencies(); identity = identify(options.port)
        receipt = json.loads(options.backup.with_suffix('.json').read_text(encoding='utf-8'))
        raw = options.backup.read_bytes()
        if receipt['deviceId'] != identity or len(raw) != 8388608 or hashlib.sha256(raw).hexdigest() != receipt['backupSha256']:
            raise ValueError('Backup does not match this device or failed integrity validation.')
        esptool(options.port, 'write-flash', '0', options.backup); emit('restored', device_id=identity)
    else:
        emit('status', result=call(options, 'status'))
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        emit('error', message=str(error) if not isinstance(error, KeyboardInterrupt) else 'Interrupted; inspect the backup and host device status before retrying.')
        sys.exit(1)
