import base64
from contextlib import contextmanager
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from PIL import Image
from sqlalchemy import create_engine, event, text
from sqlalchemy.exc import OperationalError

from gallery_files import ImageUnavailable, MAX_IMAGE_BYTES, read_image_file
from lan_gateway import BoundedServer, load_routes, make_handler
import lan_client
from product_gallery import Gallery, TOOLS


def rpc(name, arguments, request_id=1):
    return {'jsonrpc': '2.0', 'id': request_id, 'method': 'tools/call',
            'params': {'name': name, 'arguments': arguments}}


def payload(response):
    return json.loads(response['result']['content'][0]['text'])


class GalleryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cardbush-gallery-test-')
        self.base = Path(self.temp.name)
        self.root = self.base / 'gallery'
        self.root.mkdir()
        self.picture = self.root / 'product.png'
        Image.new('RGB', (32, 24), '#123456').save(self.picture)
        self.data = self.picture.read_bytes()
        self.engine = create_engine('sqlite:///' + (self.base / 'fixture.db').as_posix())
        with self.engine.begin() as connection:
            connection.execute(text('''CREATE TABLE "dwd.jst_product_image_gallery" (
                short_name TEXT PRIMARY KEY, image_file_path TEXT, sha256 TEXT,
                width INTEGER, height INTEGER, download_status TEXT, updated_at TEXT)'''))
            for code, path, status in [('ABC123', self.picture, 'ready'),
                                       ('中文货号', self.picture, 'ready'),
                                       ('FAILED', self.picture, 'failed')]:
                connection.execute(text('''INSERT INTO "dwd.jst_product_image_gallery"
                    VALUES (:code, :path, :sha, 32, 24, :status, '2026-10-29')'''),
                    {'code': code, 'path': str(path), 'sha': hashlib.sha256(self.data).hexdigest(), 'status': status})
        self.gallery = Gallery(self.engine, self.root)

    def tearDown(self):
        self.engine.dispose()
        self.temp.cleanup()

    def test_exact_ordered_lookup_has_missing_and_unavailable_without_local_paths(self):
        value = payload(self.gallery.handle(rpc('lookup_product_images',
                        {'product_codes': ['ABC123', 'UNKNOWN', 'FAILED', 'ABC123', '中文货号']})))
        self.assertEqual([x['product_code'] for x in value['items']], ['ABC123', 'UNKNOWN', 'FAILED', '中文货号'])
        self.assertEqual([x['status'] for x in value['items']], ['ready', 'not_found', 'unavailable', 'ready'])
        self.assertNotIn(str(self.root), json.dumps(value))
        self.assertNotIn('image_file_path', json.dumps(value))
        self.assertEqual(value['match'], 'exact_short_name')

    def test_image_bytes_are_delivered_without_filesystem_access_on_client(self):
        result = self.gallery.handle(rpc('get_product_image', {'product_code': 'ABC123'}))['result']
        self.assertFalse(result['isError'])
        self.assertEqual(result['content'][1]['mimeType'], 'image/png')
        self.assertEqual(base64.b64decode(result['content'][1]['data']), self.data)
        self.assertEqual(len(result['content']), 2)

    def test_invalid_arguments_and_write_tools_never_touch_database(self):
        with patch.object(self.gallery, 'rows', side_effect=AssertionError('DB must not be reached')):
            for arguments in [None, [], {}, {'product_code': '../secret'}, {'product_code': 'C:\\secret'},
                              {'product_code': 'ABC123', 'image_root': 'C:\\'},
                              {'product_code': 'ABC123', 'database_url': 'postgresql://secret'},
                              {'product_code': ''}, {'product_code': 'X' * 101},
                              {'product_code': 'X\x00Y'}, {'product_code': 1}]:
                self.assertTrue(self.gallery.handle(rpc('get_product_image', arguments))['result']['isError'])
            for codes in [[], 'ABC123', [1], ['X'] * 21]:
                self.assertTrue(self.gallery.handle(rpc('lookup_product_images', {'product_codes': codes}))['result']['isError'])
            for tool in ['sync', 'write_file', 'execute_sql', 'get_product_image/../../secret']:
                self.assertIn('error', self.gallery.handle(rpc(tool, {})))

    def test_database_query_is_parameterized_scoped_and_read_only(self):
        statements = []
        def record(conn, cursor, statement, parameters, context, executemany):
            statements.append((statement, parameters))
        event.listen(self.engine, 'before_cursor_execute', record)
        try:
            injection = "ABC123'OR'1'='1"
            value = payload(self.gallery.handle(rpc('lookup_product_images', {'product_codes': [injection]})))
            self.assertEqual(value['items'][0]['status'], 'not_found')
            select = next((s, p) for s, p in statements if s.startswith('SELECT'))
            self.assertIn('WHERE short_name IN', select[0])
            self.assertIn('LIMIT 20', select[0])
            self.assertNotIn(injection, select[0])
            self.assertIn(injection, select[1])
            with self.engine.connect() as connection:
                with self.assertRaises(OperationalError):
                    connection.execute(text('DELETE FROM "dwd.jst_product_image_gallery"'))
        finally:
            event.remove(self.engine, 'before_cursor_execute', record)

    def test_database_and_image_errors_never_expose_internal_configuration(self):
        with patch.object(self.gallery, 'rows', side_effect=RuntimeError('postgresql://user:secret@internal/db')):
            response = self.gallery.handle(rpc('get_product_image', {'product_code': 'ABC123'}))
            self.assertEqual(payload(response), {'status': 'gallery_unavailable'})
            self.assertNotIn('secret', json.dumps(response))

    def test_missing_failed_changed_and_nonimage_files_return_no_image(self):
        for code, status in [('MISSING', 'not_found'), ('FAILED', 'unavailable')]:
            response = self.gallery.handle(rpc('get_product_image', {'product_code': code}))
            self.assertEqual(payload(response)['status'], status)
            self.assertEqual(len(response['result']['content']), 1)
        self.picture.write_bytes(b'secret is not a product image')
        response = self.gallery.handle(rpc('get_product_image', {'product_code': 'ABC123'}))
        self.assertEqual(payload(response)['status'], 'image_changed')
        row = {'short_name': 'ABC123', 'download_status': 'ready', 'image_file_path': str(self.picture),
               'sha256': hashlib.sha256(self.picture.read_bytes()).hexdigest()}
        with patch.object(self.gallery, 'rows', return_value={'ABC123': row}):
            response = self.gallery.handle(rpc('get_product_image', {'product_code': 'ABC123'}))
        self.assertTrue(response['result']['isError'])
        self.assertEqual(len(response['result']['content']), 1)

    def test_file_boundary_rejects_external_relative_traversal_directory_and_oversize(self):
        outside = self.base / 'secret.png'
        outside.write_bytes(self.data)
        for path in [outside, 'product.png', self.root / '..' / 'secret.png', self.root]:
            with self.assertRaises(ImageUnavailable):
                read_image_file(self.root, path)
        huge = self.root / 'huge.png'
        with huge.open('wb') as file:
            file.truncate(MAX_IMAGE_BYTES + 1)
        with self.assertRaises(ImageUnavailable):
            read_image_file(self.root, huge)

    def test_hardlinks_are_rejected_even_with_matching_image_digest(self):
        alias = self.root / 'alias.png'
        os.link(self.picture, alias)
        with self.assertRaises(ImageUnavailable):
            read_image_file(self.root, self.picture)
        with self.assertRaises(ImageUnavailable):
            read_image_file(self.root, alias)

    def test_legacy_gallery_requires_an_explicit_root_and_keeps_link_protection(self):
        legacy = self.base / 'legacy'
        legacy.mkdir()
        picture = legacy / 'old.png'
        picture.write_bytes(self.data)
        with self.assertRaises(ImageUnavailable):
            self.gallery.read_image(picture)
        configured = Gallery(self.engine, self.root, [legacy])
        self.assertEqual(configured.read_image(picture), self.data)
        with self.assertRaises(ImageUnavailable):
            configured.read_image(self.base / 'not-a-gallery.png')
        os.link(picture, legacy / 'alias.png')
        with self.assertRaises(ImageUnavailable):
            configured.read_image(picture)

    def test_file_and_parent_symlinks_are_rejected(self):
        outside = self.base / 'outside'
        outside.mkdir()
        (outside / 'image.png').write_bytes(self.data)
        file_link = self.root / 'linked.png'
        dir_link = self.root / 'linked'
        os.symlink(outside / 'image.png', file_link)
        os.symlink(outside, dir_link, target_is_directory=True)
        try:
            for path in [file_link, dir_link / 'image.png']:
                with self.assertRaises(ImageUnavailable):
                    read_image_file(self.root, path)
        finally:
            file_link.unlink()
            dir_link.unlink()

    def test_file_changed_during_read_is_rejected_before_returning_bytes(self):
        real_fstat = os.fstat
        calls = 0
        def changed(fd):
            nonlocal calls
            calls += 1
            value = real_fstat(fd)
            if calls == 2:
                from types import SimpleNamespace
                return SimpleNamespace(**{key: getattr(value, key) for key in
                    ['st_dev', 'st_ino', 'st_size', 'st_nlink', 'st_ctime_ns']}, st_mtime_ns=value.st_mtime_ns + 1)
            return value
        with patch('gallery_files.os.fstat', side_effect=changed):
            with self.assertRaises(ImageUnavailable):
                read_image_file(self.root, self.picture)

    def test_native_platform_path_race_protection(self):
        if os.name != 'nt':
            # Native POSIX path opening must fail rather than follow a replaced parent.
            with patch('gallery_files.os.open', side_effect=OSError('replacement')):
                with self.assertRaises(ImageUnavailable):
                    read_image_file(self.root, self.picture)
            return
        import gallery_files
        original_read = gallery_files._read_fd
        def attempt_rename(fd):
            with self.assertRaises(OSError):
                os.rename(self.root, self.base / 'replaced')
            with self.assertRaises(OSError):
                os.rename(self.picture, self.root / 'replaced.png')
            return original_read(fd)
        with patch('gallery_files._read_fd', side_effect=attempt_rename):
            self.assertEqual(read_image_file(self.root, self.picture), self.data)
        # Handles must be released after the read.
        self.picture.rename(self.root / 'after.png')

    def test_native_reparse_or_fifo_and_alternate_streams_are_rejected(self):
        if os.name != 'nt':
            fifo = self.root / 'pipe'
            os.mkfifo(fifo)
            with self.assertRaises(ImageUnavailable):
                read_image_file(self.root, fifo)
            return
        junction = self.root / 'junction'
        subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(junction), str(self.base)],
                       check=True, capture_output=True)
        try:
            with self.assertRaises(ImageUnavailable):
                read_image_file(self.root, junction / 'gallery' / self.picture.name)
        finally:
            os.rmdir(junction)
        for path in [str(self.picture) + ':stream', str(self.picture) + '.', str(self.picture) + ' ']:
            with self.assertRaises(ImageUnavailable):
                read_image_file(self.root, path)

    @contextmanager
    def gateway(self):
        route = {'token': 'test-token-' * 4, 'allowed_tools': {t['name'] for t in TOOLS}, 'handler': self.gallery.handle}
        server = BoundedServer(('127.0.0.1', 0), make_handler({'/mcp/gallery': route}, [ipaddress.ip_network('127.0.0.0/8')]))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server, route
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_http_gateway_and_existing_client_deliver_images_with_route_auth(self):
        with self.gateway() as (server, route):
            (self.base / 'fixture.json').write_text(json.dumps({
                'url': f'http://127.0.0.1:{server.server_port}/mcp/gallery', 'token': route['token']}))
            with patch.dict(os.environ, {'CARDBUSH_PLUGIN_CONNECTIONS': str(self.base)}):
                descriptor = {'id': 'fixture', 'version': '1', 'tools': TOOLS}
                response = lan_client.handle(rpc('get_product_image', {'product_code': 'ABC123'}), descriptor)
            self.assertEqual(base64.b64decode(response['result']['content'][1]['data']), self.data)
            for token, name, status in [('wrong', 'get_product_image', 401),
                                        (route['token'], 'sync', 403)]:
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=3)
                try:
                    connection.request('POST', '/mcp/gallery', json.dumps(rpc(name, {'product_code': 'ABC123'})),
                                       {'Authorization': 'Bearer ' + token})
                    result = connection.getresponse()
                    self.assertEqual(result.status, status)
                    self.assertNotIn(base64.b64encode(self.data), result.read())
                finally:
                    connection.close()

    def test_route_factory_receives_only_administrator_settings(self):
        import types
        calls = []
        module = types.SimpleNamespace(TOOLS=TOOLS, create_handler=lambda settings: calls.append(settings) or self.gallery.handle)
        with patch('lan_gateway.importlib.import_module', return_value=module):
            routes = load_routes({'routes': [{'path': '/mcp/gallery', 'module': 'fixture',
                'token': 'x' * 40, 'allowed_tools': ['get_product_image'], 'settings': {'image_root': str(self.root)}}]})
        self.assertEqual(calls, [{'image_root': str(self.root)}])
        self.assertEqual(payload(routes['/mcp/gallery']['handler'](rpc('get_product_image', {'product_code': 'ABC123'})))['status'], 'ready')


if __name__ == '__main__':
    unittest.main()
