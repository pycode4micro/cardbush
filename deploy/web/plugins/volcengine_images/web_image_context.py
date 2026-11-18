"""Shared account-scoped image queue and fixed private gateway for web tools."""
import os
from pathlib import Path

import httpx

from volcengine_plugins.client import SeedreamClient
from volcengine_plugins.image_jobs import ImageJobs

ROOT = Path(os.environ["ZHAOCAI_PERSONAL_ROOT"]).resolve(strict=True)
GATEWAY = os.environ["ZHAOCAI_IMAGE_GATEWAY"]
TOKEN = os.environ["ZHAOCAI_IMAGE_TOKEN"]
jobs = ImageJobs(Path(os.environ["ZHAOCAI_IMAGE_STATE"]))


class GatewayTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request):
        async with httpx.AsyncClient(timeout=300, follow_redirects=False, trust_env=False) as session:
            response = await session.post(GATEWAY, content=await request.aread(), headers={
                "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json",
            })
        return httpx.Response(response.status_code, content=response.content, headers=response.headers, request=request)


def client():
    return SeedreamClient(api_key=TOKEN, output_dir=ROOT / "generated", transport=GatewayTransport())


async def authorize_local_processing():
    async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as session:
        response = await session.get(GATEWAY.removesuffix("/images/generations") + "/authorize",
                                     headers={"Authorization": "Bearer " + TOKEN})
    if response.status_code in {401, 403}:
        raise ValueError("当前账号的图片插件权限已关闭，请联系管理员。")
    if response.status_code != 200 or response.json().get("allowed") is not True:
        raise ValueError("图片工具权限暂时无法验证，请稍后重试。")
