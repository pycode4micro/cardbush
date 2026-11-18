"""Restricted web image plugin integration with an isolated provider fixture."""
import asyncio
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from threading import Thread

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from PIL import Image


def image_data(size, color):
    buffer = io.BytesIO()
    Image.new("RGBA", size, color).save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class Gateway(BaseHTTPRequestHandler):
    requests = []
    allowed = True

    def log_message(self, *_):
        pass

    def reply(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply({"allowed": self.allowed}, 200 if self.allowed else 403)

    def do_POST(self):
        self.requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
        self.reply({"data": [
            {"z_index": 0, "b64_json": image_data((1024, 1024), (230, 240, 250, 255))},
            {"z_index": 1, "name": "Heading", "bounding_box": {"absolute": [50, 40, 350, 160]},
             "b64_json": image_data((300, 120), (240, 60, 60, 255)),
             "text_recognition": {"text": "SALE", "lines": [{"runs": [{"style": {"foreground_color": "#17245e", "bold": True}}]}]}},
        ]})


async def verify(root, origin):
    personal = root / "workspaces"
    personal.mkdir()
    reference = personal / "Poster.png"
    Image.new("RGBA", (1024, 1024), "#FFFFFF").save(reference)
    outside = root / "outside.png"
    Image.new("RGBA", (128, 128), "#CCCCCC").save(outside)
    entry = Path(__file__).resolve().parents[1] / "deploy/web/plugins/volcengine_images/web_image_server.py"
    params = StdioServerParameters(command=sys.executable, args=[str(entry)], env={
        **os.environ,
        "ZHAOCAI_PERSONAL_ROOT": str(personal),
        "ZHAOCAI_IMAGE_STATE": str(root / "jobs"),
        "ZHAOCAI_IMAGE_GATEWAY": origin + "/images/generations",
        "ZHAOCAI_IMAGE_TOKEN": "local-fixture-token",
    })
    async with stdio_client(params) as (reader, writer), ClientSession(reader, writer) as session:
        await session.initialize()
        catalog = {tool.name for tool in (await session.list_tools()).tools}
        assert {"seedream_layer_create_task", "seedream_layer_project", "seedream_layer_edit", "seedream_layer_export"} <= catalog

        async def call(name, **args):
            response = await session.call_tool(name, args)
            assert not response.isError, response.structuredContent
            return response.structuredContent

        request = {"reference_path": str(reference), "prompt": "Separate the headline", "request_id": "web-layer-test-001", "max_images": 2}
        rejected = await session.call_tool("seedream_layer_create_task", {**request, "reference_path": str(outside)})
        assert rejected.isError and not Gateway.requests
        task = (await call("seedream_layer_create_task", **request))["task"]["id"]
        assert (await call("seedream_layer_create_task", **request))["task"]["id"] == task
        await call("generation_wait_tasks", tasks=[{"task_id": task}], timeout_seconds=10)
        project = await call("seedream_layer_project", action="status", task_id=task)
        pid = project["project_id"]
        assert (await call("seedream_layer_project", action="status", task_id=task))["project_id"] == pid
        first = await call("seedream_layer_project", action="open", project_id=pid)
        assert first["layers"][1]["recognized_text"] == "SALE"
        assert "_meta" not in first and "asset" not in first["layers"][0]

        first_edit = await call("seedream_layer_edit", project_id=pid, expected_revision=1,
                                changes=[{"id": "layer-001", "text": {"content": "SUMMER", "font_size": 34}}])
        style = first_edit["layers"][1]["text"]
        assert style["color"] == "#17245e" and style["bold"] and style["font_size"] == 34
        second = await call("seedream_layer_edit", project_id=pid, expected_revision=2,
                            changes=[{"id": "layer-001", "text": {"content": "WINTER"}}])
        assert second["revision"] == 3
        assert second["layers"][0] == first["layers"][0]
        assert second["layers"][1]["text"] == {**style, "content": "WINTER"}
        stale = await session.call_tool("seedream_layer_edit", {"project_id": pid, "expected_revision": 2,
                                             "changes": [{"id": "layer-001", "text": {"content": "STALE"}}]})
        assert stale.isError and stale.structuredContent["error"]["code"] == "conflict"
        output = await call("seedream_layer_export", project_id=pid, layer_id="layer-001", format="png", revision=3)
        assert output["artifacts"][0]["path"] == output["path"]
        with Image.open(output["path"]) as exported:
            assert exported.size == (300, 120) and exported.mode == "RGBA"
            assert exported.getchannel("A").getextrema() == (0, 255)
        Gateway.allowed = False
        denied = await session.call_tool("seedream_layer_export", {"project_id": pid, "layer_id": "layer-001"})
        assert denied.isError
        assert len(Gateway.requests) == 1
        assert Gateway.requests[0]["layer_decomposition_options"] == {"max_images": 2, "text_recognition": True}


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    Thread(target=server.serve_forever, daemon=True).start()
    try:
        with TemporaryDirectory(prefix="cb-layer-plugin-") as path:
            asyncio.run(verify(Path(path), f"http://127.0.0.1:{server.server_port}"))
        print("Verified layer tools, one split, text-only revisions, transparent export, and revoked access.")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
