"""Account-local Seedream 5.5 layer editor. Only called by the private Web Agent."""
from __future__ import annotations

import asyncio
import json
from contextlib import closing
from pathlib import Path
import sys
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from volcengine_plugins.image_jobs import account_scope
from volcengine_plugins.layer_models import ExportFormat, LayerChange, LayerError
from volcengine_plugins.layers import LayerStore
from volcengine_plugins.models import ImageRequest, LayerDecompositionOptions, LocalOptions
from web_image_server import ROOT, authorize_local_processing, client, jobs

MODEL = "doubao-seedream-5-5-261028"
REQUEST_PREFIX = "web-layers-"
STORE = LayerStore(ROOT / "generated" / "layer-projects")


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["list", "create", "status", "open", "restore", "edit", "export"]
    request_id: str | None = Field(default=None, pattern=r"^[0-9a-f-]{36}$")
    task_id: str | None = Field(default=None, pattern=r"^img-[a-f0-9]{32}$")
    project_id: str | None = Field(default=None, pattern=r"^layers-[a-f0-9]{32}$")
    reference_path: str | None = Field(default=None, max_length=4096)
    prompt: str | None = Field(default=None, max_length=2000)
    max_images: int = Field(default=8, ge=2, le=100)
    size: Literal["1K", "1.5K", "2K"] = "1K"
    revision: int | None = Field(default=None, ge=1)
    expected_revision: int | None = Field(default=None, ge=1)
    source_revision: int | None = Field(default=None, ge=1)
    changes: list[LayerChange] = Field(default_factory=list, max_length=100)
    format: ExportFormat = "png"
    layer_id: str | None = Field(default=None, pattern=r"^layer-[0-9]{3}$")


def personal_image(value, root=ROOT):
    if not isinstance(value, str):
        raise LayerError("invalid_image")
    path = Path(value)
    if not path.is_absolute():
        raise LayerError("invalid_image")
    path = path.resolve(strict=True)
    if not path.is_relative_to(root.resolve()) or not path.is_file() or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise LayerError("invalid_image")
    return path


def task_rows(scope, task_id=None):
    with closing(jobs._db()) as db, db:
        jobs._reap(db)
        args = [scope, REQUEST_PREFIX + "%"]
        sql = "SELECT id, status, created FROM jobs WHERE account=? AND request_key LIKE ?"
        if task_id is not None:
            sql += " AND id=?"
            args.append(task_id)
        return [dict(row) for row in db.execute(sql + " ORDER BY created DESC LIMIT 30", args)]


def title_for(task_id, title=None):
    with STORE.db() as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS job_titles (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        if title:
            db.execute("INSERT OR IGNORE INTO job_titles VALUES (?,?)", (task_id, title))
        row = db.execute("SELECT title FROM job_titles WHERE id=?", (task_id,)).fetchone()
    return row[0] if row else "Seedream 5.5"


def snapshot(scope):
    with STORE.db() as db:
        imported = {row[0] for row in db.execute("SELECT source FROM projects WHERE source IS NOT NULL")}
        db.execute("CREATE TABLE IF NOT EXISTS job_titles (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
        titles = dict(db.execute("SELECT id,title FROM job_titles"))
    tasks = [dict(row, title=titles.get(row["id"], "Seedream 5.5")) for row in task_rows(scope) if row["id"] not in imported]
    return {"projects": STORE.list(), "tasks": tasks}


def panel(document):
    return {"_meta": {"seedream_layers": STORE.view(document)}}


def local_command(command, scope):
    action = command.action
    if action == "list":
        return snapshot(scope)
    if action == "status":
        if not command.task_id or not task_rows(scope, command.task_id):
            raise LayerError("not_found")
        task = jobs.get(command.task_id, scope)["task"]
        if task["status"] != "succeeded":
            return {"task": {"id": task["id"], "status": task["status"], "error": task.get("result", {}).get("error")}}
        data = task["result"].get("data")
        if not isinstance(data, list) or not data or any(not isinstance(item, dict) for item in data):
            raise LayerError("invalid_result")
        for item in data:
            personal_image(item.get("local_path"), ROOT / "generated")
        project = STORE.import_result(task["result"], title_for(task["id"]), source=task["id"])
        return {"task": {"id": task["id"], "status": "succeeded"}, "project_id": project["id"]}
    if action == "open":
        return panel(STORE.get(command.project_id, command.revision))
    if action == "restore":
        if command.source_revision is None or command.expected_revision is None:
            raise LayerError("invalid_request")
        return panel(STORE.restore(command.project_id, command.expected_revision, command.source_revision))
    if action == "edit":
        for change in command.changes:
            if change.replacement_path is not None:
                change.replacement_path = str(personal_image(change.replacement_path))
            if change.text and change.text.font_path:
                raise LayerError("invalid_request")
        return panel(STORE.edit(command.project_id, command.expected_revision, command.changes))
    return {"structuredContent": STORE.export(command.project_id, command.revision, command.format, command.layer_id)}


async def dispatch(raw):
    command = Command.model_validate(raw)
    await authorize_local_processing()
    image_client = client()
    if command.action != "create":
        return await asyncio.to_thread(local_command, command, account_scope(image_client))
    if not command.request_id or not command.prompt or not command.prompt.strip():
        raise LayerError("invalid_request")
    path = personal_image(command.reference_path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise LayerError("invalid_image")
    request = ImageRequest(
        model=MODEL, prompt=command.prompt.strip(), size=command.size, watermark=False,
        response_format="b64_json", output_format="png",
        layer_decomposition=True,
        layer_decomposition_options=LayerDecompositionOptions(max_images=command.max_images, text_recognition=True),
    )
    receipt = await jobs.create(image_client, request, LocalOptions(reference_images=[str(path)]),
                                REQUEST_PREFIX + command.request_id)
    await asyncio.to_thread(title_for, receipt["task"]["id"], path.stem[:160])
    return {"task": {key: receipt["task"][key] for key in ("id", "status")}}


async def serve():
    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline):
            request = json.loads(line)
            try:
                value = await dispatch(request["input"])
            except (ValidationError, ValueError, OSError, KeyError, TypeError) as error:
                code = error.code if isinstance(error, LayerError) else "invalid_request"
                value = {"isError": True, "structuredContent": {"error": {"code": code}}}
            except Exception:
                value = {"isError": True, "structuredContent": {"error": {"code": "service_unavailable"}}}
            print(json.dumps({"id": request["id"], "value": value}, ensure_ascii=False), flush=True)
    finally:
        await jobs.close()


if __name__ == "__main__":
    asyncio.run(serve())
