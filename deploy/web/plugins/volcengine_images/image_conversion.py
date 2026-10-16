"""Deterministic personal-image conversion in a bounded asynchronous worker."""
import asyncio
import json
import math
import os
from pathlib import Path
import stat
import sys
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 16_000_000
WORKER_TIMEOUT = 25
STITCH_TIMEOUT = 65
MAX_REQUEST_BYTES = 1024 * 1024
MAX_STITCH_INPUT_BYTES = 512 * 1024 * 1024
workers = asyncio.Semaphore(1)


class ConversionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_path: str = Field(min_length=1, max_length=2048, description='Absolute image path in this account personal folder; never a URL.')
    width: int | None = Field(default=None, ge=1, le=8192, strict=True, description='Target width in pixels. Supply width and height together, or omit both to only change format.')
    height: int | None = Field(default=None, ge=1, le=8192, strict=True, description='Target height in pixels.')
    output_format: Literal['png', 'jpg', 'jpeg', 'webp'] = 'png'
    fit: Literal['contain', 'crop', 'stretch'] = Field(default='contain', description='contain: preserve whole image with white padding (default); crop: center crop to fill; stretch: distort to exact size only when explicitly requested.')
    quality: int = Field(default=95, ge=1, le=100, strict=True, description='JPEG/WebP quality; PNG is lossless.')

    @model_validator(mode='after')
    def dimensions(self):
        if (self.width is None) != (self.height is None):
            raise ValueError('请同时指定目标宽度和高度。')
        if self.width and self.width * self.height > MAX_PIXELS:
            raise ValueError('目标图片不能超过 1600 万像素。')
        return self


class StitchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    source_paths: list[Annotated[str, Field(min_length=1, max_length=2048)]] = Field(min_length=2, max_length=64, description='2..64 absolute personal image paths, placed in this exact order from left to right, then top to bottom.')
    layout: Literal['grid', 'horizontal', 'vertical'] = 'grid'
    columns: int | None = Field(default=None, ge=1, le=64, strict=True, description='Grid columns; omit for a near-square grid. Only valid with grid layout.')
    cell_width: int = Field(default=384, ge=32, le=4096, strict=True, description='Image area width per tile, in pixels; not the total output width.')
    cell_height: int = Field(default=384, ge=32, le=4096, strict=True, description='Image area height per tile, excluding its optional number label.')
    gap: int = Field(default=8, ge=0, le=64, strict=True)
    padding: int = Field(default=8, ge=0, le=64, strict=True)
    numbered: bool = Field(default=True, strict=True, description='Add an index below each image so the overview can be matched to the original paths.')
    fit: Literal['contain', 'crop', 'stretch'] = Field(default='contain', description='Preserve full images with white padding by default; crop or stretch only when explicitly requested.')
    output_format: Literal['png', 'jpg', 'jpeg', 'webp'] = 'jpg'
    quality: int = Field(default=92, ge=1, le=100, strict=True)

    def geometry(self):
        count = len(self.source_paths)
        columns = count if self.layout == 'horizontal' else 1 if self.layout == 'vertical' else self.columns or math.ceil(math.sqrt(count))
        columns = min(columns, count)
        rows = math.ceil(count / columns)
        label_height = 24 if self.numbered else 0
        width = self.padding * 2 + columns * self.cell_width + (columns - 1) * self.gap
        height = self.padding * 2 + rows * (self.cell_height + label_height) + (rows - 1) * self.gap
        return columns, rows, label_height, width, height

    @model_validator(mode='after')
    def dimensions(self):
        if self.layout != 'grid' and self.columns is not None:
            raise ValueError('columns 仅用于网格布局；横向或纵向拼接请省略它。')
        _, _, _, width, height = self.geometry()
        if max(width, height) > 8192 or width * height > MAX_PIXELS:
            raise ValueError('拼接总图最长边不能超过 8192 像素、总计 1600 万像素，请减小单格尺寸或改用网格布局。')
        return self


async def convert_image(root: Path, request: ConversionRequest, authorize=None):
    return await _run_worker(root, request, 'convert', authorize)


async def stitch_images(root: Path, request: StitchRequest, authorize=None):
    return await _run_worker(root, request, 'stitch', authorize)


async def _run_worker(root, request, operation, authorize):
    # Keep image decoding/encoding off the MCP event loop. One worker per account;
    # the container, process memory/CPU limits and deadline also bound bad images.
    async with workers:
        if authorize is not None:
            await authorize()
        process = await asyncio.create_subprocess_exec(
            sys.executable, '-I', '-B', str(Path(__file__).resolve()),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            env={'PATH': os.defpath},
        )
        try:
            payload = json.dumps({'root': str(root), 'operation': operation, 'request': request.model_dump()}, ensure_ascii=False).encode()
            output, _ = await asyncio.wait_for(process.communicate(payload), timeout=STITCH_TIMEOUT if operation == 'stitch' else WORKER_TIMEOUT)
            value = json.loads(output) if output else {}
            if process.returncode or 'task' not in value:
                raise ValueError(value.get('error', '图片处理未完成，图片可能超过处理限制，请缩小尺寸或减少图片张数后重试。'))
            return value
        except asyncio.TimeoutError as error:
            raise ValueError('图片处理超时，请降低目标尺寸或减少图片张数后重试。') from error
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()


def _directory(parent: int, name: str, create=False):
    if create:
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent)
        except FileExistsError:
            pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)


def _source(root: Path, source: str, root_fd: int):
    path = Path(source)
    if not path.is_absolute() or not path.is_relative_to(root) or '..' in path.parts or '\x00' in source:
        raise ValueError('只能处理当前账号个人文件夹内的图片。')
    parts = path.relative_to(root).parts
    if not parts or path.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
        raise ValueError('只支持静态 PNG、JPG、WebP 图片。')
    parent = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = _directory(parent, part)
            os.close(parent)
            parent = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or not 0 < info.st_size <= MAX_BYTES:
                raise ValueError('需要不超过 16 MB 的个人图片文件。')
            return os.fdopen(descriptor, 'rb')
        except BaseException:
            os.close(descriptor)
            raise
    finally:
        os.close(parent)


def _save_image(root, root_fd, canvas, output_format, quality, prefix, label):
    # New private output only, with a descriptor-relative atomic rename. No metadata
    # or caller-controlled output path is copied from the source images.
    extension = 'jpg' if output_format in {'jpg', 'jpeg'} else output_format
    encoding = {'png': 'PNG', 'jpg': 'JPEG', 'webp': 'WEBP'}[extension]
    options = {'compress_level': 6} if extension == 'png' else {'quality': quality}
    if extension == 'jpg':
        options['subsampling'] = 0
    generated = _directory(root_fd, 'generated', create=True)
    folder = prefix + '-' + uuid4().hex
    folder_fd = None
    name = f'{label}_{canvas.width}x{canvas.height}.{extension}'
    try:
        os.mkdir(folder, mode=0o700, dir_fd=generated)
        folder_fd = _directory(generated, folder)
        fd = os.open('.encoding', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=folder_fd)
        with os.fdopen(fd, 'wb') as output:
            canvas.save(output, format=encoding, **options)
            length = output.tell()
            if length > MAX_BYTES:
                raise ValueError('处理结果超过 16 MB，请减小尺寸或改用 JPG/WebP。')
        os.replace('.encoding', name, src_dir_fd=folder_fd, dst_dir_fd=folder_fd)
    except BaseException:
        if folder_fd is not None:
            try:
                os.unlink('.encoding', dir_fd=folder_fd)
            except FileNotFoundError:
                pass
        try:
            os.rmdir(folder, dir_fd=generated)
        except OSError:
            pass
        raise
    finally:
        if folder_fd is not None:
            os.close(folder_fd)
        os.close(generated)
    return folder, {'local_path': str(root / 'generated' / folder / name), 'width': canvas.width, 'height': canvas.height,
                    'format': extension, 'mime': 'image/jpeg' if extension == 'jpg' else 'image/' + extension, 'bytes': length}


def _convert(root: Path, request: ConversionRequest):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    root = root.resolve(strict=True)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        with _source(root, request.source_path, root_fd) as file, Image.open(file) as source:
            if source.format not in {'PNG', 'JPEG', 'WEBP'} or getattr(source, 'n_frames', 1) != 1:
                raise ValueError('只支持静态 PNG、JPG、WebP 图片，不支持动图或视频。')
            if source.width * source.height > MAX_PIXELS:
                raise ValueError('原图片不能超过 1600 万像素。')
            source.load()
            oriented = ImageOps.exif_transpose(source)
            source.close()
            size = (request.width, request.height) if request.width else oriented.size
            if max(size) > 8192 or size[0] * size[1] > MAX_PIXELS:
                raise ValueError('目标图片单边不能超过 8192 像素，总计不能超过 1600 万像素。')
            rgba = oriented.convert('RGBA')
            oriented.close()
            if request.fit == 'contain':
                image = ImageOps.contain(rgba, size, Image.Resampling.LANCZOS)
            elif request.fit == 'crop':
                image = ImageOps.fit(rgba, size, Image.Resampling.LANCZOS)
            else:
                image = rgba.resize(size, Image.Resampling.LANCZOS)
            if image is not rgba:
                rgba.close()
            canvas = Image.new('RGB', size, 'white')
            canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2), image)
            image.close()
            try:
                folder, item = _save_image(root, root_fd, canvas, request.output_format, request.quality, 'converted', '图片')
            finally:
                canvas.close()
            return {'task': {'id': folder, 'kind': 'image_conversion', 'status': 'succeeded',
                             'result': {'data': [{**item, 'fit': request.fit}]}}, 'paid_request_sent': False}
    finally:
        os.close(root_fd)


def _stitch(root: Path, request: StitchRequest):
    from PIL import Image, ImageDraw, ImageFont, ImageOps
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    root = root.resolve(strict=True)
    root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    columns, rows, label_height, width, height = request.geometry()
    canvas = None
    try:
        canvas = Image.new('RGB', (width, height), 'white')
        draw = ImageDraw.Draw(canvas)
        font = ImageFont.load_default(size=16) if request.numbered else None
        total_bytes, sources = 0, []
        for index, path in enumerate(request.source_paths):
            # Only one decoded source is kept at a time, even for a 64-image sheet.
            with _source(root, path, root_fd) as file, Image.open(file) as source:
                total_bytes += os.fstat(file.fileno()).st_size
                if total_bytes > MAX_STITCH_INPUT_BYTES:
                    raise ValueError('拼接原图总大小不能超过 512 MB，请分组拼接。')
                if source.format not in {'PNG', 'JPEG', 'WEBP'} or getattr(source, 'n_frames', 1) != 1:
                    raise ValueError('只支持静态 PNG、JPG、WebP 图片，不支持动图或视频。')
                if source.width * source.height > MAX_PIXELS:
                    raise ValueError('每张原图片不能超过 1600 万像素。')
                source.load()
                oriented = ImageOps.exif_transpose(source)
                source.close()
                rgba = oriented.convert('RGBA')
                oriented.close()
                try:
                    size = (request.cell_width, request.cell_height)
                    if request.fit == 'contain':
                        tile = ImageOps.contain(rgba, size, Image.Resampling.LANCZOS)
                    elif request.fit == 'crop':
                        tile = ImageOps.fit(rgba, size, Image.Resampling.LANCZOS)
                    else:
                        tile = rgba.resize(size, Image.Resampling.LANCZOS)
                    column, row = index % columns, index // columns
                    x = request.padding + column * (request.cell_width + request.gap)
                    y = request.padding + row * (request.cell_height + label_height + request.gap)
                    try:
                        canvas.paste(tile, (x + (request.cell_width - tile.width) // 2,
                                            y + (request.cell_height - tile.height) // 2), tile)
                    finally:
                        if tile is not rgba:
                            tile.close()
                    if request.numbered:
                        draw.text((x + 4, y + request.cell_height + 3), f'{index + 1:02d}', fill='#333333', font=font)
                    sources.append({'index': index + 1, 'source_path': path, 'row': row + 1, 'column': column + 1})
                finally:
                    rgba.close()
        folder, item = _save_image(root, root_fd, canvas, request.output_format, request.quality, 'stitched', '拼图')
        return {'task': {'id': folder, 'kind': 'image_stitch', 'status': 'succeeded', 'result': {
            'data': [{**item, 'image_count': len(sources), 'fit': request.fit}], 'sources': sources,
            'layout': {'columns': columns, 'rows': rows, 'cell_width': request.cell_width,
                       'cell_height': request.cell_height, 'gap': request.gap, 'padding': request.padding, 'numbered': request.numbered},
        }}, 'paid_request_sent': False}
    finally:
        if canvas is not None:
            canvas.close()
        os.close(root_fd)


def _main():
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (384 * 1024 * 1024, 384 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (55, 56))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES + 1024, MAX_BYTES + 1024))
    try:
        payload = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(payload) > MAX_REQUEST_BYTES:
            raise ValueError('图片处理参数过长。')
        value = json.loads(payload)
        if value.get('operation', 'convert') == 'stitch':
            result = _stitch(Path(value['root']), StitchRequest.model_validate(value['request']))
        elif value.get('operation', 'convert') == 'convert':
            resource.setrlimit(resource.RLIMIT_CPU, (20, 21))
            result = _convert(Path(value['root']), ConversionRequest.model_validate(value['request']))
        else:
            raise ValueError('未知图片处理操作。')
    except ValueError as error:
        result = {'error': str(error)}
    except Exception:
        result = {'error': '图片无法处理，请确认每张都是个人文件夹内有效的静态图片，且未超过大小限制。'}
    print(json.dumps(result, ensure_ascii=False))
    return 1 if 'error' in result else 0


if __name__ == '__main__':
    raise SystemExit(_main())
