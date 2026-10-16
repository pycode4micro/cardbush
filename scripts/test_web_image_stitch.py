import asyncio
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest

from PIL import Image
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy/web/plugins/volcengine_images'))
import image_conversion
from image_conversion import StitchRequest, stitch_images


class ImageStitchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'alice' / 'workspaces'
        self.root.mkdir(parents=True)
        self.paths = []
        for name, size, color in [('wide', (160, 80), 'red'), ('tall', (80, 160), 'blue'), ('square', (100, 100), 'green')]:
            path = self.root / (name + '.png')
            Image.new('RGB', size, color).save(path)
            self.paths.append(str(path))
        self.hashes = [hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in self.paths]

    async def stitch(self, paths=None, **options):
        receipt = await stitch_images(self.root, StitchRequest(source_paths=paths or self.paths, **options))
        self.assertFalse(receipt['paid_request_sent'])
        self.assertEqual(receipt['task']['kind'], 'image_stitch')
        self.assertEqual(receipt['task']['status'], 'succeeded')
        result = receipt['task']['result']
        self.assertTrue(Path(result['data'][0]['local_path']).is_relative_to(self.root / 'generated'))
        self.assertEqual(self.hashes, [hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in self.paths])
        return result

    async def test_order_full_images_empty_cell_and_number_mapping(self):
        result = await self.stitch(columns=2, cell_width=100, cell_height=100, gap=8, padding=8, output_format='png')
        self.assertEqual([(item['index'], item['source_path'], item['row'], item['column']) for item in result['sources']],
                         [(1,self.paths[0],1,1),(2,self.paths[1],1,2),(3,self.paths[2],2,1)])
        with Image.open(result['data'][0]['local_path']) as output:
            self.assertEqual(output.size, (224,272))
            self.assertEqual(output.getpixel((58,20)), (255,255,255))
            self.assertEqual(output.getpixel((58,58)), (255,0,0))
            self.assertEqual(output.getpixel((120,58)), (255,255,255))
            self.assertEqual(output.getpixel((166,58)), (0,0,255))
            self.assertEqual(output.getpixel((58,190)), (0,128,0))
            self.assertEqual(output.getpixel((166,190)), (255,255,255))
            self.assertLess(min(output.crop((8,108,40,132)).convert('L').getdata()), 255)

    async def test_horizontal_vertical_and_explicit_crop(self):
        for layout, size in [('horizontal',(192,64)),('vertical',(64,192))]:
            result = await self.stitch(layout=layout, cell_width=64, cell_height=64, padding=0, gap=0, numbered=False, fit='crop', output_format='png')
            with Image.open(result['data'][0]['local_path']) as output:
                self.assertEqual(output.size,size)
                for index, color in enumerate([(255,0,0),(0,0,255),(0,128,0)]):
                    point = (index*64+32,32) if layout=='horizontal' else (32,index*64+32)
                    self.assertEqual(output.getpixel(point),color)

    async def test_64_images_complete_once_in_order_and_formats(self):
        paths = [self.paths[index % 3] for index in range(64)]
        result = await self.stitch(paths)
        self.assertEqual(result['data'][0]['image_count'],64)
        self.assertEqual([item['source_path'] for item in result['sources']],paths)
        self.assertEqual(result['layout']['columns'],8)
        self.assertEqual(result['layout']['rows'],8)
        with Image.open(result['data'][0]['local_path']) as output:
            self.assertEqual(output.format,'JPEG')
            self.assertEqual(output.size,(3144,3336))
        for requested, encoding in [('png','PNG'),('jpg','JPEG'),('jpeg','JPEG'),('webp','WEBP')]:
            result = await self.stitch(output_format=requested, cell_width=64, cell_height=64)
            with Image.open(result['data'][0]['local_path']) as output:
                self.assertEqual(output.format,encoding)

    async def test_exif_rotation_and_transparency(self):
        source = Image.new('RGB',(80,40),'red')
        source.paste('blue',(0,0,40,40))
        exif=Image.Exif();exif[274]=6
        oriented=self.root/'oriented.png';source.save(oriented,exif=exif)
        transparent=self.root/'transparent.png';Image.new('RGBA',(40,80),(0,255,0,0)).save(transparent)
        result=await self.stitch([str(oriented),str(transparent)],layout='horizontal',cell_width=40,cell_height=80,padding=0,gap=0,numbered=False,output_format='png')
        with Image.open(result['data'][0]['local_path']) as output:
            self.assertEqual(output.size,(80,80))
            self.assertEqual(output.getpixel((20,20)),(0,0,255))
            self.assertEqual(output.getpixel((20,60)),(255,0,0))
            self.assertEqual(output.getpixel((60,40)),(255,255,255))
            self.assertFalse(output.getexif())

    async def test_rejects_escape_links_and_any_invalid_member_without_output(self):
        outside=self.base/'bob.png';outside.write_bytes(Path(self.paths[0]).read_bytes())
        linked=self.root/'linked.png';linked.symlink_to(outside)
        hard=self.root/'hard.png';os.link(outside,hard)
        redirect=self.root/'redirect';redirect.symlink_to(self.base,target_is_directory=True)
        for path in [str(outside),str(linked),str(hard),str(redirect/'bob.png'),str(self.root/'..'/'..'/'bob.png'),'https://example.test/image.png']:
            with self.subTest(path=path),self.assertRaises(ValueError):
                await self.stitch([self.paths[0],path])
        corrupt=self.root/'corrupt.png';corrupt.write_bytes(b'not an image')
        animated=self.root/'animated.png'
        Image.new('RGB',(20,20),'red').save(animated,save_all=True,append_images=[Image.new('RGB',(20,20),'blue')],duration=10)
        for path in [corrupt,animated]:
            with self.assertRaises(ValueError):
                await self.stitch([self.paths[0],str(path)])
        self.assertFalse((self.root/'generated').exists())
        (self.root/'generated').symlink_to(self.base,target_is_directory=True)
        with self.assertRaises(ValueError):
            await self.stitch()
        self.assertEqual(list(self.base.glob('stitched-*')),[])

    async def test_rejects_count_dimensions_and_overflow(self):
        for changes in [{'source_paths':self.paths[:1]},{'source_paths':self.paths*22},
                        {'layout':'horizontal','columns':2},{'cell_width':True},
                        {'cell_width':4096,'cell_height':4096},{'columns':0},
                        {'output_path':'/tmp/out.png'},{'output_format':'svg'},
                        {'source_paths':[self.paths[0],2]},{'numbered':'yes'}]:
            with self.subTest(changes=changes),self.assertRaises(ValidationError):
                StitchRequest(**{'source_paths':self.paths,**changes})

    async def test_queued_authorization_is_rechecked_and_worker_is_shared(self):
        await image_conversion.workers.acquire()
        checks=[]
        async def denied():
            checks.append(True)
            raise ValueError('revoked')
        pending=asyncio.create_task(stitch_images(self.root,StitchRequest(source_paths=self.paths),denied))
        await asyncio.sleep(.02)
        self.assertFalse(checks)
        self.assertFalse(pending.done())
        image_conversion.workers.release()
        with self.assertRaisesRegex(ValueError,'revoked'):
            await pending
        self.assertEqual(checks,[True])
        self.assertFalse((self.root/'generated').exists())

    async def test_async_processing_keeps_event_loop_responsive(self):
        ticks=0
        async def heartbeat():
            nonlocal ticks
            while True:
                ticks+=1
                await asyncio.sleep(.01)
        heartbeat_task=asyncio.create_task(heartbeat())
        try:
            await self.stitch(self.paths*20)
            self.assertGreater(ticks,5)
        finally:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass


if __name__=='__main__':
    unittest.main()
