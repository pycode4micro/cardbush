"""Local, revisioned Seedream layer projects; no network or generation calls."""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import json
import math
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image
from .config import get_config
from .layer_models import LayerChange, LayerError, TextStyle
from .layer_render import compose, font_for, layer_image, png_bytes


def coordinates(box, width, height):
    if not isinstance(box, dict):
        raise LayerError("missing_coordinates")
    values = box.get("absolute")
    normalized = values is None
    if normalized:
        values = box.get("normalized")
    if not isinstance(values, list) or len(values) != 4 or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in values):
        raise LayerError("missing_coordinates")
    if normalized:
        if any(not 0 <= value <= 1000 for value in values):
            raise LayerError("invalid_geometry")
        values = [v * (width if i % 2 == 0 else height) / 1000 for i, v in enumerate(values)]
    x, y, right, bottom = values
    if not (-32768 <= x <= 32768 and -32768 <= y <= 32768 and 1 <= right - x <= 8192 and 1 <= bottom - y <= 8192):
        raise LayerError("invalid_geometry")
    return dict(x=x, y=y, width=right - x, height=bottom - y)


def image_file(value):
    path = Path(value).expanduser() if isinstance(value, str) else Path()
    if not isinstance(value, str) or not path.is_absolute() or not path.is_file() or path.stat().st_size > 64 * 1024 * 1024:
        raise LayerError("invalid_image")
    try:
        with Image.open(path) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"} or image.width * image.height > 36_000_000 or max(image.size) > 8192:
                raise LayerError("invalid_image")
            image.load()
            return image.convert("RGBA")
    except (OSError, ValueError, Image.DecompressionBombError):
        raise LayerError("invalid_image") from None


class LayerStore:
    def __init__(self, root: Path | None = None):
        self.root = root or Path(get_config("SEEDREAM_OUTPUT_DIR", str(Path.home() / "Pictures" / "Seedream"))) / "layer-projects"

    @contextmanager
    def db(self):
        self.root.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.root / "projects.sqlite3", timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, revision INTEGER, source TEXT UNIQUE, updated REAL)")
            connection.execute("CREATE TABLE IF NOT EXISTS revisions (id TEXT, revision INTEGER, document TEXT, created REAL, PRIMARY KEY(id,revision))")
            connection.commit()
            yield connection
        finally:
            connection.close()

    def directory(self, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r"layers-[a-f0-9]{32}", project_id):
            raise LayerError("not_found")
        directory = self.root / project_id
        if not directory.resolve().is_relative_to(self.root.resolve()):
            raise LayerError("invalid_asset")
        return directory

    def get(self, project_id, revision=None):
        self.directory(project_id)
        if revision is not None and (type(revision) is not int or revision < 1):
            raise LayerError("invalid_request")
        with self.db() as db:
            current = db.execute("SELECT revision FROM projects WHERE id=?", (project_id,)).fetchone()
            if current is None:
                raise LayerError("not_found")
            row = db.execute("SELECT document FROM revisions WHERE id=? AND revision=?", (project_id, revision or current[0])).fetchone()
            if row is None:
                raise LayerError("not_found")
            return json.loads(row[0])

    def list(self):
        with self.db() as db:
            rows = db.execute("SELECT r.document,p.updated FROM projects p JOIN revisions r ON r.id=p.id AND r.revision=p.revision ORDER BY p.updated DESC LIMIT 100").fetchall()
            return [{key: json.loads(row[0])[key] for key in ("id", "title", "revision", "width", "height")} | {"updated": row[1]} for row in rows]

    def history(self, project_id):
        self.get(project_id)
        with self.db() as db:
            return [dict(row) for row in db.execute("SELECT revision,created FROM revisions WHERE id=? ORDER BY revision DESC LIMIT 200", (project_id,))]

    def _save(self, document, expected_revision, *, source=None):
        project_id = document["id"]
        with self.db() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute("SELECT revision FROM projects WHERE id=?", (project_id,)).fetchone()
            actual = current[0] if current else 0
            if actual != expected_revision:
                raise LayerError("conflict", expected=expected_revision, actual=actual)
            document = copy.deepcopy(document)
            document["revision"] = actual + 1
            now = time.time()
            db.execute("INSERT INTO revisions VALUES (?,?,?,?)", (project_id, actual + 1, json.dumps(document, ensure_ascii=False, allow_nan=False), now))
            if current:
                db.execute("UPDATE projects SET revision=?,updated=? WHERE id=?", (actual + 1, now, project_id))
            else:
                db.execute("INSERT INTO projects VALUES (?,?,?,?)", (project_id, 1, source, now))
            db.commit()
        return document

    def _asset(self, project_id, image):
        data = png_bytes(image)
        relative = "assets/" + hashlib.sha256(data).hexdigest() + ".png"
        target = self.directory(project_id) / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            with target.open("xb") as file:
                file.write(data)
        except FileExistsError:
            if target.read_bytes() != data:
                raise LayerError("invalid_asset")
        return relative

    def import_result(self, result, title="Seedream layers", *, source=None):
        if source:
            with self.db() as db:
                existing = db.execute("SELECT id FROM projects WHERE source=?", (source,)).fetchone()
            if existing:
                return self.get(existing[0])
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 160:
            raise LayerError("invalid_request")
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, list) or not 2 <= len(data) <= 100 or any(not isinstance(item, dict) for item in data):
            raise LayerError("invalid_result")
        # Seedream uses z_index=0 for the base; do not infer a missing layer's position.
        bases = [i for i, item in enumerate(data) if item.get("z_index") == 0]
        if len(bases) != 1 or any(type(item.get("z_index")) is not int or not 0 <= item["z_index"] <= 1000 for item in data):
            raise LayerError("invalid_result")
        base = image_file(data[bases[0]].get("local_path"))
        width, height = base.size
        project_id = "layers-" + uuid.uuid4().hex
        layers = []
        for index, item in enumerate(data):
            if item.get("save_error"):
                raise LayerError("invalid_result")
            image = base if index == bases[0] else image_file(item.get("local_path"))
            geometry = dict(x=0, y=0, width=width, height=height) if index == bases[0] else coordinates(item.get("bounding_box"), width, height)
            metadata = {key: item[key] for key in ("bounding_box", "text_recognition", "description") if key in item}
            if len(json.dumps(metadata, ensure_ascii=False, allow_nan=False)) > 200000:
                raise LayerError("invalid_result")
            layer = {"id": f"layer-{index:03d}", "name": str(item.get("name") or ("Base" if index == bases[0] else f"Layer {index}"))[:160],
                     "asset": self._asset(project_id, image), "z_index": item["z_index"],
                     "visible": True, "opacity": 1.0, "text": None, "metadata": metadata, **geometry}
            layers.append(layer)
        document = {"format": "seedream-layer-project", "version": 1, "id": project_id, "revision": 0,
                    "title": title, "width": width, "height": height, "layers": layers}
        try:
            return self._save(document, 0, source=source)
        except sqlite3.IntegrityError:
            # Concurrent opens of one completed task converge without another paid call.
            if source:
                with self.db() as db:
                    row = db.execute("SELECT id FROM projects WHERE source=?", (source,)).fetchone()
                if row:
                    return self.get(row[0])
            raise

    def edit(self, project_id, expected_revision, changes):
        document = self.get(project_id)
        if document["revision"] != expected_revision:
            raise LayerError("conflict", expected=expected_revision, actual=document["revision"])
        if not 1 <= len(changes) <= 100 or len({change.id for change in changes}) != len(changes):
            raise LayerError("invalid_request")
        for change in changes:
            layer = next((item for item in document["layers"] if item["id"] == change.id), None)
            if layer is None:
                raise LayerError("not_found")
            patch = change.model_dump(exclude_unset=True, exclude={"id", "replacement_path"})
            if any(value is None and key != "text" for key, value in patch.items()):
                raise LayerError("invalid_request")
            if change.replacement_path:
                layer["asset"] = self._asset(project_id, image_file(change.replacement_path))
                layer["text"] = None
            if patch.get("text") is not None:
                font_for(TextStyle.model_validate(patch["text"]))
            layer.update(patch)
            if layer["width"] * layer["height"] > 36_000_000:
                raise LayerError("invalid_geometry")
        return self._save(document, expected_revision)

    def restore(self, project_id, expected_revision, source_revision):
        return self._save(self.get(project_id, source_revision), expected_revision)

    def view(self, document):
        directory = self.directory(document["id"])
        thumbnails, originals = {}, {}
        edge = 384 if len(document["layers"]) <= 16 else 128
        for layer in document["layers"]:
            thumbnails[layer["id"]] = "data:image/png;base64," + base64.b64encode(png_bytes(layer_image(directory, layer), max_edge=edge)).decode()
            if layer.get("text"):
                originals[layer["id"]] = "data:image/png;base64," + base64.b64encode(png_bytes(layer_image(directory, dict(layer, text=None)), max_edge=edge)).decode()
        return {"document": document, "history": self.history(document["id"]), "thumbnails": thumbnails, "original_thumbnails": originals}

    def export(self, project_id, revision=None, format="png", layer_id=None):
        document = self.get(project_id, revision)
        directory = self.directory(project_id)
        exports = directory / "exports"
        exports.mkdir(parents=True, exist_ok=True)
        suffix = "jpg" if format == "jpeg" else format
        if format not in {"png", "jpeg", "zip"}:
            raise LayerError("invalid_request")
        target = exports / f"v{document['revision']}-{uuid.uuid4().hex}.{suffix}"
        if layer_id:
            layer = next((item for item in document["layers"] if item["id"] == layer_id), None)
            if layer is None or format != "png":
                raise LayerError("invalid_request")
            canvas = layer_image(directory, layer)
        else:
            canvas = compose(directory, document)
        with target.open("xb") as file:
            if format == "png":
                canvas.save(file, "PNG")
            elif format == "jpeg":
                flattened = Image.new("RGB", canvas.size, "white")
                flattened.paste(canvas, mask=canvas.getchannel("A"))
                flattened.save(file, "JPEG", quality=95)
            else:
                portable = copy.deepcopy(document)
                with ZipFile(file, "w", ZIP_DEFLATED) as archive:
                    archive.writestr("composite.png", png_bytes(canvas))
                    for layer in portable["layers"]:
                        # Export both original pixels and edited pixels. No local font
                        # paths or provider signed URLs are included in the package.
                        archive.writestr(f"layers/{layer['id']}.png", png_bytes(layer_image(directory, layer)))
                        asset = layer["asset"]
                        if asset not in archive.namelist():
                            archive.write(directory / asset, asset)
                        if layer.get("text"):
                            layer["text"]["font_path"] = None
                    archive.writestr("project.json", json.dumps(portable, ensure_ascii=False, indent=2))
        return {"project_id": project_id, "revision": document["revision"], "path": str(target.resolve()), "format": format,
                "artifacts": [{"path": str(target.resolve()), "type": "document" if format == "zip" else "image", "display": "attachment", "readOnly": True}]}
