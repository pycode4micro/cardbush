"""Build importable Windows plugin folders from an explicit private build plan.

The plan and outputs are intentionally outside tracked source. This command never
starts business services, changes installed plugins, or copies user credentials.
"""
from __future__ import annotations
import json
from pathlib import Path
import shutil
import subprocess
import sys
from portable_python import copy_runtime

EXCLUDED = {'.git', '.venv', 'node_modules', '__pycache__', '.pytest_cache', 'build', 'tests', 'test', 'logs', 'storage'}

def private_file(path: Path):
    name = path.name.lower()
    return (name.startswith('.env') and not name.endswith(('.example', '.sample', '.template'))
            or name.endswith(('.pyc', '.pfx', '.p12', '.key', '.sqlite', '.sqlite3', '.db'))
            or name.endswith('.local.json') or '.bak' in name
            or name in {'credentials.json', 'connections.json', 'direct_url.json', 'mcp-oauth.bin'})

def copy_source(source: Path, target: Path):
    if source.is_symlink() or source.is_junction():
        raise ValueError(f'Source must not contain symlinks: {source.name}')
    if source.is_dir():
        if source.name in EXCLUDED or source.name.endswith('.egg-info'):
            return
        target.mkdir(parents=True, exist_ok=True)
        for child in source.iterdir():
            copy_source(child, target / child.name)
    elif not private_file(source):
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

def build(plan):
    output = Path(plan['output']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    launcher = Path(plan['launcher'])
    reports = []
    for item in plan['plugins']:
        target = output / item['id']
        if target.exists():
            if (target / 'portable-build.json').exists():
                reports.append(json.loads((target / 'portable-build.json').read_text(encoding='utf-8')))
                continue
            raise ValueError(f'Unfinished build directory: {target}')
        copy_source(Path(item['source']), target)
        for extra in item.get('extra', []):
            copy_source(Path(extra['source']), target / extra['destination'])
        kind = item['kind']
        dependencies = []
        if kind == 'python':
            deps = item['python']
            dependencies = copy_runtime(Path(deps['base']), Path(deps['site']), target / 'portable-runtime', deps['requirements'])
        elif kind == 'node':
            (target / 'portable-runtime').mkdir()
            shutil.copy2(plan['node'], target / 'portable-runtime/node.exe')
        if kind in {'python', 'node'}:
            shutil.copy2(launcher, target / (item['id'] + '.exe'))
            config = {'executable': 'portable-runtime/' + ('python.exe' if kind == 'python' else 'node.exe'),
                      'args': item['args'], 'environment': item.get('environment', {})}
            (target / 'portable-runtime.json').write_text(json.dumps(config, indent=2), encoding='utf-8')
            mcp = {'mcpServers': {item['server']: {'type': 'stdio', 'command': '${PLUGIN_ROOT}/' + item['id'] + '.exe', 'args': []}}}
            (target / '.mcp.json').write_text(json.dumps(mcp, indent=2), encoding='utf-8')
            # Remove alternate development launch configurations from the distribution.
            for name in ('mcp.json', 'mcp.posix.json'):
                if (target / name).exists():
                    portable = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', **mcp}
                    (target / name).write_text(json.dumps(portable, indent=2), encoding='utf-8')
        report = {'id': item['id'], 'kind': kind, 'dependencies': dependencies}
        (target / 'portable-build.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        reports.append(report)
        print(json.dumps({'built': item['id'], 'dependencies': len(dependencies)}), flush=True)
    (output.parent / 'plugin-build-report.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')

if __name__ == '__main__':
    build(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8-sig')))
