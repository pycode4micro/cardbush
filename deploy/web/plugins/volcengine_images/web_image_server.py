"""Restricted host adapter; async receipts/workers/waits come from the native plugin."""
import json
import os
from pathlib import Path
from contextlib import asynccontextmanager
from typing import Literal
import httpx
from pydantic import BaseModel, ConfigDict, Field
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from volcengine_plugins.client import SeedreamClient, capabilities
from volcengine_plugins.models import ImageRequest, LocalOptions
from volcengine_plugins.image_jobs import ImageJobs, account_scope
from volcengine_plugins.generation_wait import GenerationTask, wait_tasks
from image_conversion import ConversionRequest, StitchRequest, convert_image, stitch_images

ROOT = Path(os.environ['ZHAOCAI_PERSONAL_ROOT']).resolve(strict=True)
GATEWAY = os.environ['ZHAOCAI_IMAGE_GATEWAY']
TOKEN = os.environ['ZHAOCAI_IMAGE_TOKEN']
jobs = ImageJobs(Path(os.environ['ZHAOCAI_IMAGE_STATE']))

class GatewayTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        # This transport has one destination; neither model arguments nor URLs can change it.
        async with httpx.AsyncClient(timeout=300, follow_redirects=False, trust_env=False) as client:
            response = await client.post(GATEWAY, content=await request.aread(), headers={
                'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
        return httpx.Response(response.status_code, content=response.content, headers=response.headers, request=request)

def client():
    return SeedreamClient(api_key=TOKEN, output_dir=ROOT / 'generated', transport=GatewayTransport())

def result(value):
    return CallToolResult(content=[TextContent(type='text', text=json.dumps(value, ensure_ascii=False))], structuredContent=value)

@asynccontextmanager
async def lifespan(_):
    try:
        yield {}
    finally:
        await jobs.close()

server = FastMCP('Zhaocai Images', lifespan=lifespan, instructions='Only personal images. Use image_stitch to combine 2..64 existing images into a numbered overview, preserving source order. For comparing many images, stitch an overview and inspect its returned local_path with inject_image_input, then inspect individual originals only for detail. Use image_convert for exact pixel dimensions or PNG/JPG/WebP conversion. Both are local, preserve full images with white-padded contain by default, and never call generation. For new image generation, create once and wait for the same task; no paid retries. Display returned local_path with Markdown images. Account folder only.')
read = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)

class Request(BaseModel):
    model_config = ConfigDict(extra='forbid')
    prompt: str = Field(min_length=1, max_length=12000)
    size: str = Field(default='2K', max_length=24)
    watermark: bool = False
    reference_images: list[str] = Field(default_factory=list, max_length=4)

class ImageTask(BaseModel):
    model_config = ConfigDict(extra='forbid')
    kind: Literal['seedream'] = 'seedream'
    task_id: str = Field(pattern=r'^[A-Za-z0-9_-]{1,220}$')

@server.tool(annotations=read)
def seedream_capabilities() -> dict:
    return {'image_only': True, 'async': True, 'model': capabilities()['profile'], 'sizes': ['1K','2K','WIDTHxHEIGHT'], 'references': 4, 'personal_root': str(ROOT),
            'local_conversion': {'tool': 'image_convert', 'formats': ['png','jpg','webp'], 'max_edge': 8192, 'max_pixels': 16_000_000, 'default_fit': 'contain', 'padding': 'white'},
            'local_stitch': {'tool': 'image_stitch', 'max_images': 64, 'layouts': ['grid','horizontal','vertical'], 'default_cell_pixels': 384, 'numbered': True, 'default_fit': 'contain', 'max_edge': 8192, 'max_pixels': 16_000_000}}


async def authorize_local_processing():
    # Recheck the administrator grant after waiting for the shared worker slot.
    async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as session:
        response = await session.get(GATEWAY.removesuffix('/images/generations') + '/authorize',
                                     headers={'Authorization': 'Bearer ' + TOKEN})
    if response.status_code in {401, 403}:
        raise ValueError('当前账号的图片插件权限已关闭，请联系管理员。')
    if response.status_code != 200 or response.json().get('allowed') is not True:
        raise ValueError('图片工具权限暂时无法验证，请稍后重试。')


@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
async def image_convert(request: ConversionRequest) -> CallToolResult:
    """Resize an existing personal image to exact width x height pixels and/or convert PNG/JPG/WebP locally. Default contain preserves the whole image with white padding. Crop/stretch only when explicitly requested. Writes a NEW image in this account's generated folder, never overwrites the source, never invokes a generation model. Omit both dimensions for format-only conversion. Returns the completed local_path after asynchronous processing; show it as a Markdown image and download artifact."""
    return result(await convert_image(ROOT, request, authorize_local_processing))


@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False))
async def image_stitch(request: StitchRequest) -> CallToolResult:
    """Combine 2..64 existing personal images into ONE downloadable overview, with no generation/model call. Grid (automatic or explicit columns), horizontal and vertical layouts; source order is left-to-right then top-to-bottom. Default 384px tiles, white padding, whole-image contain, numeric labels, JPG. cell_width/height are per tile, not total size. Writes a new image without changing originals. For reviewing multiple images, inspect the returned local_path with inject_image_input; numbers correspond to result.sources. Split larger sets into groups of at most 64 without silently dropping files. Show the result as a Markdown image and download artifact."""
    return result(await stitch_images(ROOT, request, authorize_local_processing))

@server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True))
async def seedream_create_task(request: Request, request_id: str) -> CallToolResult:
    """Generate/edit an image in the native background queue. Reuse request_id after a lost receipt. Returns task.id immediately; wait for that ID, never submit again to poll. References must be absolute personal file paths."""
    references = []
    total = 0
    for reference in request.reference_images:
        path = Path(reference).resolve(strict=True)
        if not path.is_relative_to(ROOT) or not path.is_file() or path.suffix.lower() not in {'.png','.jpg','.jpeg','.webp'}:
            raise ValueError('Only personal image files may be used.')
        total += path.stat().st_size
        if total > 16 * 1024 * 1024:
            raise ValueError('Reference images exceed 16 MiB.')
        references.append(str(path))
    native = ImageRequest(prompt=request.prompt, size=request.size, watermark=request.watermark, response_format='b64_json', output_format='png')
    options = LocalOptions(reference_images=references, save_images=True)
    return result(await jobs.create(client(), native, options, request_id))

@server.tool(annotations=read)
def seedream_get_task(task_id: str) -> CallToolResult:
    """Read an existing image task receipt. This does not submit or retry generation."""
    return result(jobs.get(task_id, account_scope(client())))

@server.tool(annotations=read)
async def generation_wait_tasks(tasks: list[ImageTask], timeout_seconds: int = 60, mode: Literal['any','all'] = 'any') -> CallToolResult:
    """Wait 0..120 seconds for existing image tasks. Only status=timeout means pending; wait again using pending IDs. The background generation survives wait cancellation and browser disconnect."""
    async def query(task):
        return jobs.get(task.task_id, account_scope(client()))
    native = [GenerationTask(kind='seedream', task_id=task.task_id) for task in tasks]
    return result(await wait_tasks(native, query, timeout_seconds=timeout_seconds, mode=mode))

if __name__ == '__main__':
    server.run(transport='stdio')
