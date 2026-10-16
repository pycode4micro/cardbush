"""Linux worker regression tests using synthetic images only."""
import asyncio
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/web/plugins/volcengine_images'))
from image_conversion import ConversionRequest, convert_image


class ImageConversionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'alice' / 'workspaces'
        self.root.mkdir(parents=True)
        self.source = self.root / 'input.png'
        Image.new('RGB', (160, 80), 'red').save(self.source)
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()

    async def convert(self, **options):
        value = await convert_image(self.root, ConversionRequest(source_path=str(self.source), **options))
        self.assertFalse(value['paid_request_sent'])
        self.assertEqual(value['task']['kind'], 'image_conversion')
        self.assertEqual(value['task']['status'], 'succeeded')
        item = value['task']['result']['data'][0]
        self.assertTrue(Path(item['local_path']).is_relative_to(self.root / 'generated'))
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.digest)
        return item

    async def test_exact_size_white_padding_and_new_output(self):
        first = await self.convert(width=100, height=100)
        second = await self.convert(width=100, height=100)
        self.assertNotEqual(first['local_path'], second['local_path'])
        with Image.open(first['local_path']) as output:
            self.assertEqual(output.size, (100, 100))
            self.assertEqual(output.format, 'PNG')
            self.assertEqual(output.getpixel((50, 0)), (255, 255, 255))
            self.assertEqual(output.getpixel((50, 24)), (255, 255, 255))
            self.assertEqual(output.getpixel((50, 25)), (255, 0, 0))
            self.assertEqual(output.getpixel((50, 74)), (255, 0, 0))
            self.assertEqual(output.getpixel((50, 75)), (255, 255, 255))

    async def test_formats_and_format_only_conversion(self):
        for requested, expected in [('png', 'PNG'), ('jpg', 'JPEG'), ('jpeg', 'JPEG'), ('webp', 'WEBP')]:
            item = await self.convert(output_format=requested)
            with Image.open(item['local_path']) as output:
                self.assertEqual(output.format, expected)
                self.assertEqual(output.size, (160, 80))
            self.assertEqual(Path(item['local_path']).stat().st_size, item['bytes'])

    async def test_explicit_crop_and_stretch_fill_exact_dimensions(self):
        for fit in ['crop', 'stretch']:
            item = await self.convert(width=99, height=101, fit=fit)
            with Image.open(item['local_path']) as output:
                self.assertEqual(output.size, (99, 101))
                self.assertEqual(output.getpixel((0, 0)), (255, 0, 0))

    async def test_orientation_and_transparency_on_white(self):
        exif = Image.Exif(); exif[274] = 6
        Image.new('RGBA', (160, 80), (255, 0, 0, 0)).save(self.source, exif=exif)
        self.digest = hashlib.sha256(self.source.read_bytes()).hexdigest()
        item = await self.convert(output_format='jpg')
        with Image.open(item['local_path']) as output:
            self.assertEqual(output.size, (80, 160))
            self.assertEqual(output.getpixel((0, 0)), (255, 255, 255))
            self.assertFalse(output.getexif())

    async def test_rejects_other_accounts_traversal_symlinks_and_output_redirects(self):
        outside = self.base / 'bob.png'; outside.write_bytes(self.source.read_bytes())
        (self.root / 'linked.png').symlink_to(outside)
        (self.root / 'linked-dir').symlink_to(self.base, target_is_directory=True)
        for path in [outside, self.root / '..' / '..' / 'bob.png', self.root / 'linked.png', self.root / 'linked-dir' / 'bob.png']:
            with self.subTest(path=str(path)), self.assertRaises(ValueError):
                await convert_image(self.root, ConversionRequest(source_path=str(path)))
        other = self.base / 'other'; other.mkdir()
        (self.root / 'generated').symlink_to(other, target_is_directory=True)
        with self.assertRaises(ValueError):
            await self.convert(width=50, height=50)
        self.assertEqual(list(other.iterdir()), [])

    async def test_rejects_animation_forged_images_and_invalid_dimensions(self):
        Image.new('RGB', (10, 10), 'red').save(self.source, format='PNG', save_all=True,
            append_images=[Image.new('RGB', (10, 10), 'blue')], duration=10)
        with self.assertRaisesRegex(ValueError, '动图'):
            await self.convert()
        self.source.write_bytes(b'not an image')
        with self.assertRaises(ValueError):
            await self.convert()
        for options in [{'width': 200}, {'width': 0, 'height': 100}, {'width': True, 'height': 100},
                        {'width': 8193, 'height': 1}, {'width': 4001, 'height': 4000}, {'output_format': 'svg'},
                        {'output_path': '/tmp/escape.png'}, {'quality': 101}]:
            with self.subTest(options=options), self.assertRaises(ValidationError):
                ConversionRequest(source_path=str(self.source), **options)

    async def test_authorization_is_rechecked_after_queueing(self):
        import image_conversion
        allowed = True
        async def authorize():
            if not allowed:
                raise ValueError('revoked')
        await image_conversion.workers.acquire()
        pending = asyncio.create_task(convert_image(self.root, ConversionRequest(source_path=str(self.source)), authorize))
        await asyncio.sleep(0)
        allowed = False
        image_conversion.workers.release()
        with self.assertRaisesRegex(ValueError, 'revoked'):
            await pending
        self.assertFalse((self.root / 'generated').exists())

    async def test_async_worker_does_not_block_event_loop(self):
        ticks = 0
        async def heartbeat():
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(.01)
        task = asyncio.create_task(heartbeat())
        try:
            await self.convert(width=1800, height=2400)
            self.assertGreater(ticks, 5)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass


if __name__ == '__main__':
    unittest.main()
