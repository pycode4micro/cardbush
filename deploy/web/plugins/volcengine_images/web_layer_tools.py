"""Seedream layer commands available to the restricted Web conversation tool catalog."""
import json
from typing import Annotated, Literal

from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field

from volcengine_plugins.layer_models import ExportFormat, LayerChange
from web_layer_worker import run_command

ProjectId = Annotated[str, Field(pattern=r"^layers-[a-f0-9]{32}$")]
TaskId = Annotated[str, Field(pattern=r"^img-[a-f0-9]{32}$")]
Revision = Annotated[int, Field(ge=1)]


def register_layer_tools(server):
    async def execute(action, **args):
        value = await run_command({"action": action, **args}, view=False)
        data = value.get("structuredContent", value)
        return CallToolResult(isError=value.get("isError", False),
                              content=[TextContent(type="text", text=json.dumps(data, ensure_ascii=False))],
                              structuredContent=data)

    local = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)

    @server.tool(annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True))
    async def seedream_layer_create_task(reference_path: Annotated[str, Field(max_length=4096)],
                                        prompt: Annotated[str, Field(min_length=1, max_length=2000)],
                                        request_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{8,100}$")],
                                        max_images: Annotated[int, Field(ge=2, le=100)] = 8,
                                        size: Literal["1K", "1.5K", "2K"] = "1K") -> CallToolResult:
        """Split one personal PNG/JPG/WebP image into a base and editable layers with Seedream 5.5 and text recognition. This is the only paid layer action. Use it once only when the user requests decomposition and there is no suitable layer project. Pass the real absolute attachment path and keep the same request_id if the submission receipt is lost. Wait on the returned task ID with generation_wait_tasks, then use seedream_layer_project(action="status", task_id=...) to import the existing result. Never regenerate to edit an existing project."""
        return await execute("create", reference_path=reference_path, prompt=prompt, request_id=request_id,
                             max_images=max_images, size=size)

    @server.tool(annotations=local)
    async def seedream_layer_project(action: Literal["list", "open", "status", "restore"],
                                     project_id: ProjectId | None = None, task_id: TaskId | None = None,
                                     revision: Revision | None = None, expected_revision: Revision | None = None,
                                     source_revision: Revision | None = None) -> CallToolResult:
        """FREE. list shows personal layer projects, including projects made with the Web Layer editor. open requires project_id and returns the current revision, each layer ID, recognized text and editable text style. status requires task_id and imports a successful existing split once. restore requires project_id, expected_revision and source_revision. Never split or redraw an image here."""
        return await execute(action, project_id=project_id, task_id=task_id, revision=revision,
                             expected_revision=expected_revision, source_revision=source_revision)

    @server.tool(annotations=local)
    async def seedream_layer_edit(project_id: ProjectId, expected_revision: Revision,
                                  changes: Annotated[list[LayerChange], Field(min_length=1, max_length=100)]) -> CallToolResult:
        """FREE. Edit only the requested layer ID from seedream_layer_project/open. To replace a headline without changing the background or other layers, send just changes=[{"id":"layer-001","text":{"content":"new text"}}] using the actual ID. Position, size, color, visibility and other unprovided properties are preserved. The first text edit renders with a built-in font and estimated OCR styling. Do not pass font_path. An explicit null text restores the raster layer. On revision conflict reopen and check before saving. Does not use image generation."""
        return await execute("edit", project_id=project_id, expected_revision=expected_revision,
                             changes=[change.model_dump(exclude_unset=True) for change in changes])

    @server.tool(annotations=local)
    async def seedream_layer_export(project_id: ProjectId, format: ExportFormat = "png",
                                    revision: Revision | None = None,
                                    layer_id: Annotated[str, Field(pattern=r"^layer-[0-9]{3}$")] | None = None) -> CallToolResult:
        """FREE. With layer_id and format="png", export only the selected layer as a transparent PNG, including an edited text layer. Omit layer_id for a composite PNG/JPG or ZIP of all layers. Returns an authenticated personal download artifact. Provide the exact returned path as a Markdown link, or a Markdown image for a PNG preview. Never redraw the image."""
        return await execute("export", project_id=project_id, format=format, revision=revision, layer_id=layer_id)
