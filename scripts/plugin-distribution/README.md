# Portable plugin distribution and read-only gateway

This directory contains reusable distribution infrastructure. Business plugins,
their service handlers, tool descriptions, deployment guides and domain tests
belong in [cardbush-plugins](https://github.com/pycode4micro/cardbush-plugins).
Build plans point to an explicit source directory in that repository; neither
repository requires a particular sibling checkout or developer profile path.

## Build and verify

Copy `example.plan.json` to a private build directory and fill in the source,
launcher, runtime and output locations. `build_plugins.py` copies sanitized
source and an explicit dependency closure. Stdlib-only Python clients use an
empty `requirements` list. Python build tooling itself requires `packaging`.

```powershell
python scripts/plugin-distribution/build_plugins.py C:/private-build/plan.json
node scripts/plugin-distribution/verify_plugins.mjs C:/private-build/plugins
node scripts/plugin-distribution/verify_host.mjs C:/private-build/plugins
node scripts/plugin-distribution/package_installer.mjs C:/private-build/plugins C:/private-build/plugins.exe
```

`verify_host.mjs` requires a built CardBush product host. The installer requires
both validation receipts, refuses to merge existing plugin directories, and
uses per-user installation. Keep build plans, runtimes, EXEs and credentials
outside tracked source. A source plugin must carry its own working MCP entry;
the packager replaces that manifest with its EXE entry for a portable build.

## Read-only HTTP gateway

`lan_gateway.py` provides bounded HTTP transport, client network restrictions,
per-route tokens and an explicit read-only tool allowlist. Administrators choose
audited handler modules supplied by the plugin repository:

- A module declares `TOOLS`, including `annotations.readOnlyHint: true`.
- A module exports `handle(request)`, or `create_handler(settings)` to construct
  a handler from administrator-owned route settings.
- A route declares `path`, `module`, `token`, `allowed_tools` and optional
  `settings`. Tool arguments cannot change these settings or the allowlist.
- Listening defaults to loopback. LAN binding additionally requires
  `lan_enabled: true` and an explicit `allowed_clients` network list.

`lan_client.py` is the reusable stdio-to-HTTP client template. It reads the
plugin's `lan-tools.json` and a separate private connection file. A distributed
plugin must include its runtime transport; it must not depend on this checkout
being present on the end user's computer.

## Tests

```powershell
python -m unittest discover -s scripts/plugin-distribution -p "test_*.py" -v
```

The suite exercises only generic packaging, manifest, authentication and handler
factory contracts. Each business plugin maintains its domain tests and an
explicit integration test against this gateway in its own repository.
