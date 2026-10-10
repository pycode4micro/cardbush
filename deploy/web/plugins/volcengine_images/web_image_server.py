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

server = FastMCP('Zhaocai Images', lifespan=lifespan, instructions='Only images. Create once, wait for the same task. No paid retries. Display local_path with Markdown images. Account folder only.')
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
    return {'image_only': True, 'async': True, 'model': capabilities()['profile'], 'sizes': ['1K','2K','WIDTHxHEIGHT'], 'references': 4, 'personal_root': str(ROOT)}

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
