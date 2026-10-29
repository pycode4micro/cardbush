"""Read-only product-code queries and authenticated MCP image delivery.

Runs beside the existing data platform, never on colleagues' computers. Only the
administrator supplies the database and image root; tool arguments cannot do so.
"""
import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import warnings

from gallery_files import ImageUnavailable, confined_path, read_image_file

DESCRIPTOR = Path(__file__).parent / 'product-gallery-plugin' / 'lan-tools.json'
TOOLS = json.loads(DESCRIPTOR.read_text(encoding='utf-8'))['tools']
CODE = re.compile(r'[^\s\x00-\x1f\x7f/\\:]{1,100}\Z')


def codes_from(arguments, single=False):
    key = 'product_code' if single else 'product_codes'
    if not isinstance(arguments, dict) or set(arguments) != {key}:
        raise ValueError('invalid_arguments')
    values = [arguments[key]] if single else arguments[key]
    if not isinstance(values, list) or not 1 <= len(values) <= 20:
        raise ValueError('invalid_product_codes')
    if any(not isinstance(v, str) or not CODE.fullmatch(v) for v in values):
        raise ValueError('invalid_product_codes')
    return list(dict.fromkeys(values))


class Gallery:
    def __init__(self, engine, image_root, legacy_image_roots=()):
        self.engine = engine
        self.image_roots = [Path(image_root), *(Path(root) for root in legacy_image_roots)]
        if any(not root.is_absolute() or '..' in root.parts for root in self.image_roots):
            raise ValueError('An absolute gallery directory is required')

    def read_image(self, filename):
        for root in self.image_roots:
            try:
                confined_path(root, filename)
            except ImageUnavailable:
                continue
            return read_image_file(root, filename)
        raise ImageUnavailable('outside_gallery')

    def rows(self, codes):
        from sqlalchemy import bindparam, text
        dialect = self.engine.dialect.name
        if dialect not in {'postgresql', 'sqlite'}:
            raise ValueError('Unsupported database')
        # SQLite is used only by isolated tests. Production uses the existing PG table.
        table = 'dwd.jst_product_image_gallery' if dialect == 'postgresql' else '"dwd.jst_product_image_gallery"'
        query = text(f'''SELECT short_name, image_file_path, sha256, width, height,
                               download_status, updated_at
                        FROM {table} WHERE short_name IN :codes LIMIT 20''')
        query = query.bindparams(bindparam('codes', expanding=True))
        with self.engine.connect() as connection:
            with connection.begin():
                if dialect == 'postgresql':
                    connection.exec_driver_sql('SET TRANSACTION READ ONLY')
                    connection.exec_driver_sql("SET LOCAL statement_timeout = '5000ms'")
                    connection.exec_driver_sql("SET LOCAL lock_timeout = '1000ms'")
                else:
                    connection.exec_driver_sql('PRAGMA query_only=ON')
                return {r['short_name']: dict(r) for r in connection.execute(query, {'codes': codes}).mappings()}

    @staticmethod
    def result(request, value, *, error=False, image=None):
        content = [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]
        if image:
            content.append(image)
        return {'jsonrpc': '2.0', 'id': request.get('id'), 'result': {'content': content, 'isError': error}}

    def handle(self, request):
        if (not isinstance(request, dict) or request.get('jsonrpc') != '2.0'
                or 'id' not in request or request.get('method') != 'tools/call'):
            return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'Invalid Request'}}
        params = request.get('params')
        if not isinstance(params, dict) or params.get('name') not in ('lookup_product_images', 'get_product_image'):
            return {'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'Unknown tool'}}
        single = params['name'] == 'get_product_image'
        try:
            codes = codes_from(params.get('arguments'), single)
        except ValueError:
            return self.result(request, {'status': 'invalid_arguments'}, error=True)
        try:
            rows = self.rows(codes)
            if not single:
                items = []
                for code in codes:
                    row = rows.get(code)
                    item = {'product_code': code, 'status': 'not_found'}
                    if row:
                        item['status'] = 'ready' if row['download_status'] == 'ready' else 'unavailable'
                        item.update(width=row['width'], height=row['height'], updated_at=str(row['updated_at']))
                    items.append(item)
                return self.result(request, {'items': items, 'match': 'exact_short_name',
                                             'next_tool': 'get_product_image'})
            row = rows.get(codes[0])
            if not row or row['download_status'] != 'ready':
                return self.result(request, {'product_code': codes[0], 'status': 'not_found' if not row else 'unavailable'})
            data = self.read_image(row['image_file_path'] or '')
            digest = hashlib.sha256(data).hexdigest()
            # Require an indexed digest. A replaced file is not the indexed product image.
            if not isinstance(row['sha256'], str) or digest != row['sha256'].lower():
                raise ImageUnavailable('image_changed')
            from PIL import Image
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(BytesIO(data)) as picture:
                    mime = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}.get(picture.format)
                    if not mime or picture.width * picture.height > 25_000_000:
                        raise ImageUnavailable('unsupported_image')
                    width, height = picture.size
                    picture.verify()
            return self.result(request, {'product_code': codes[0], 'status': 'ready',
                                        'width': width, 'height': height, 'sha256': digest},
                               image={'type': 'image', 'mimeType': mime, 'data': base64.b64encode(data).decode('ascii')})
        except ImageUnavailable as error:
            return self.result(request, {'product_code': codes[0], 'status': str(error)}, error=True)
        except Exception:
            # No DB connection strings, local paths, SQL, or credentials in client errors.
            return self.result(request, {'status': 'gallery_unavailable'}, error=True)


def create_handler(settings):
    from sqlalchemy import create_engine
    from packages.core.config import get_settings
    engine = create_engine(get_settings().database_url, pool_pre_ping=True,
                           pool_size=4, max_overflow=0, pool_timeout=5,
                           connect_args={'connect_timeout': 5})
    if engine.dialect.name != 'postgresql':
        raise ValueError('Production gallery requires PostgreSQL')
    return Gallery(engine, settings['image_root'], settings.get('legacy_image_roots', [])).handle
