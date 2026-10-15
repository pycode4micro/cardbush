"""USB/provisioning regression tests; never opens a serial port or contacts a host."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('device', ROOT/'assets/skills/embodied-connect/scripts/device.py')
device = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(device)

class InstallerTests(unittest.TestCase):
    def test_packaged_firmware_complete_and_checksummed(self):
        data = device.manifest(device.SKILL/'assets/firmware'/device.BOARD)
        self.assertEqual({i['offset'] for i in data['images']}, {0, 0x8000, 0xd000, 0x20000, 0x600000})
        self.assertEqual(data['commit'], 'd7a1c05308fb6e116ffb44b9e2c6e67b3366302a')
        with tempfile.TemporaryDirectory() as temp:
            copy = Path(temp)/'firmware'; shutil.copytree(device.SKILL/'assets/firmware'/device.BOARD, copy)
            image = copy/data['images'][0]['file']; image.write_bytes(image.read_bytes()+b'changed')
            with self.assertRaisesRegex(ValueError, 'integrity'): device.manifest(copy)

    def test_real_nvs_generator_and_temporary_secret_cleanup(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)/'wifi.bin'
            device.create_nvs(target, {'ssid': 'Fixture network', 'password': 'not-a-real-password'},
                              'ws://192.168.1.2:4782/api/embodied/v1/audio', 'a'*64)
            self.assertEqual(target.stat().st_size, 0x4000)
            self.assertFalse(target.with_suffix('.csv').exists())
            data = target.read_bytes()
            for field in [b'wifi', b'websocket', b'Fixture network', b'a'*64]: self.assertIn(field, data)

    def test_public_management_and_device_urls(self):
        for value in ['ws://example.com/api/embodied/v1/audio', 'wss://u:p@example.com/api/embodied/v1/audio', 'wss://example.com/api/embodied/v1/audio?secret=x']:
            with self.assertRaises(ValueError): device.endpoint(value)
        self.assertTrue(device.endpoint('wss://example.com/api/embodied/v1/audio'))
        self.assertIsNone(device.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.example'))

    def fixture(self, directory):
        root = Path(directory); wifi = root/'wifi.json'; wifi.write_text('{"ssid":"fixture","password":"fixture-pass"}', encoding='utf-8')
        return argparse.Namespace(firmware=device.SKILL/'assets/firmware'/device.BOARD, wifi_file=wifi,
            port='TEST-PORT-NEVER-OPENED', backup_dir=root/'backups', name='Fixture', wait=1)

    def test_install_transaction_backups_precede_pairing_and_flash(self):
        with tempfile.TemporaryDirectory() as temp:
            options = self.fixture(temp); actions = []
            def host(_options, action, value=None):
                actions.append(action)
                if action == 'status': return {'listening': True, 'listener': {'publicUrl': 'ws://192.168.1.2:4782/api/embodied/v1/audio'},
                    'voice': {'mode': 'realtime', 'provider': 'cardbush'}, 'paired': [], 'devices': {'aa:bb:cc:dd:ee:ff': {'connected': True}}}
                if action == 'pair': return {'token': 'a'*64}
            def usb(_port, action, *args):
                actions.append(action)
                if action == 'read-flash': Path(args[-1]).write_bytes(b'\xff'*8388608)
                self.assertNotIn('a'*64, str(args), 'token must not appear in the process arguments')
            with patch.object(device, 'call', host), patch.object(device, 'dependencies'), patch.object(device, 'identify', return_value='aa:bb:cc:dd:ee:ff'), patch.object(device, 'esptool', usb), patch.object(device, 'emit'):
                self.assertEqual(device.install(options), 0)
            self.assertLess(actions.index('read-flash'), actions.index('pair'))
            self.assertLess(actions.index('pair'), actions.index('write-flash'))
            receipt = json.loads(next(options.backup_dir.glob('*.json')).read_text())
            self.assertTrue(receipt['flashed']); self.assertTrue(receipt['connected']); self.assertNotIn('a'*64, json.dumps(receipt))
            self.assertEqual(hashlib.sha256(Path(receipt['backup']).read_bytes()).hexdigest(), receipt['backupSha256'])

    def test_flash_failure_revokes_but_does_not_retry_or_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            options = self.fixture(temp); actions = []
            def host(_options, action, value=None):
                actions.append(action)
                if action == 'status': return {'listening': True, 'listener': {'publicUrl': 'ws://192.168.1.2:4782/api/embodied/v1/audio'},
                    'voice': {'mode': 'realtime', 'provider': 'cardbush'}, 'paired': []}
                if action == 'pair': return {'token': 'a'*64}
            def usb(_port, action, *args):
                actions.append(action)
                if action == 'read-flash': Path(args[-1]).write_bytes(b'\xff'*8388608)
                elif action == 'write-flash': raise RuntimeError('fixture USB disconnect')
            with patch.object(device, 'call', host), patch.object(device, 'dependencies'), patch.object(device, 'identify', return_value='aa:bb:cc:dd:ee:ff'), patch.object(device, 'esptool', usb), patch.object(device, 'emit'):
                with self.assertRaisesRegex(RuntimeError, 'USB disconnect'): device.install(options)
            self.assertEqual(actions.count('write-flash'), 1); self.assertEqual(actions[-1], 'revoke')
            self.assertEqual(len(list(options.backup_dir.glob('*.bin'))), 1)

if __name__ == '__main__': unittest.main()
