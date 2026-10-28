"""Materialize CPython and an installed distribution closure, without user state."""
from __future__ import annotations
import importlib.metadata as metadata
import json
from pathlib import Path
import shutil
import sys
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


def distributions(site: Path, requirements: list[str]):
    available = {canonicalize_name(d.metadata['Name']): d for d in metadata.distributions(path=[str(site)])}
    selected = {}
    queue = [(Requirement(value), {''}) for value in requirements]
    expanded = set()
    while queue:
        request, parent_extras = queue.pop()
        if request.marker and not any(request.marker.evaluate({'extra': x}) for x in parent_extras):
            continue
        name = canonicalize_name(request.name)
        if name not in available:
            raise ValueError(f'Missing packaged dependency: {request.name}')
        dist = available[name]
        if request.specifier and not request.specifier.contains(dist.version):
            raise ValueError(f'Incompatible dependency: {request}, installed {dist.version}')
        selected[name] = dist
        extras = {''} | request.extras
        for extra in extras:
            if (name, extra) in expanded:
                continue
            expanded.add((name, extra))
            queue.extend((Requirement(value), {extra}) for value in dist.requires or [])
    return selected


def copy_runtime(base: Path, site: Path, target: Path, requirements: list[str]):
    if target.exists():
        raise ValueError('Refusing to overwrite an existing runtime')
    target.mkdir(parents=True)
    for file in base.iterdir():
        if file.is_file() and (file.suffix.lower() in {'.dll', '.exe'} or file.name == 'LICENSE.txt'):
            shutil.copy2(file, target / file.name)
    ignore = shutil.ignore_patterns('site-packages', '__pycache__', '*.pyc', 'test', 'tests', 'idlelib', 'tkinter', 'ensurepip')
    shutil.copytree(base / 'Lib', target / 'Lib', ignore=ignore)
    shutil.copytree(base / 'DLLs', target / 'DLLs', ignore=shutil.ignore_patterns('tcl*', 'tk*', '_tkinter*'))
    destination = target / 'Lib/site-packages'
    destination.mkdir()
    manifest = []
    for name, dist in sorted(distributions(site, requirements).items()):
        if not dist.files:
            raise ValueError(f'Dependency has no installed file inventory: {name}')
        copied = 0
        for item in dist.files:
            relative = Path(str(item))
            if relative.is_absolute() or '..' in relative.parts:
                continue  # Console entrypoints outside site-packages are not used.
            if relative.suffix == '.pyc' or relative.name in {'direct_url.json', 'REQUESTED', 'INSTALLER'}:
                continue
            source = site / relative
            if not source.is_file():
                raise ValueError(f'Incomplete dependency: {name}/{relative}')
            output = destination / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, output)
            copied += 1
        manifest.append({'name': name, 'version': dist.version, 'files': copied})
    # Explicit isolated search path prevents fallback to the build computer's Python.
    dll = next(base.glob('python3??.dll'))
    (target / (dll.stem + '._pth')).write_text('Lib\nDLLs\nLib/site-packages\n..\n../src\nimport site\n', encoding='utf-8')
    (target / 'dependencies.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    return manifest


if __name__ == '__main__':
    spec = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig'))
    print(json.dumps(copy_runtime(Path(spec['base']), Path(spec['site']), Path(spec['target']), spec['requirements'])))
