# Browser Use: implementation and license scope

The default connector consists of CardBush's MCP adapter
(`packages/cardbush-chrome-mcp`), Electron broker and `extension/`. Using Chrome
DevTools Protocol does not make this connector Google's MCP implementation.
CardBush-authored code and skill content follow the repository's Apache-2.0
license, reproduced in [LICENSE](LICENSE). The plugin metadata describes this
CardBush-authored layer; it does not relicense bundled dependencies.

## Advanced remote-debugging mode

`runtime/chrome-devtools-mcp/` contains **chrome-devtools-mcp 1.8.0**, authored by
Google LLC. It is used only when remote-debugging mode is explicitly selected.

- [Upstream source for this release](https://github.com/ChromeDevTools/chrome-devtools-mcp/tree/chrome-devtools-mcp-v1.8.0)
- [Bundled Apache-2.0 license](runtime/chrome-devtools-mcp/LICENSE)
- [Bundled dependency notices and license texts](runtime/chrome-devtools-mcp/build/src/third_party/THIRD_PARTY_NOTICES)

Retain the upstream license and dependency notices when redistributing this
directory. Changes to CardBush's connector do not modify this upstream bundle.

## MPL-covered dependency source

The upstream bundle includes **axe-core 4.12.1** under MPL-2.0, as recorded in its
dependency notices. Its corresponding source is available from Deque Systems:

- [Source at the npm release's git commit](https://github.com/dequelabs/axe-core/tree/5d002cca1f862a0699d9f1bb7b5a1ec334fa1b22)
- [Source archive for that commit](https://github.com/dequelabs/axe-core/archive/5d002cca1f862a0699d9f1bb7b5a1ec334fa1b22.tar.gz)
- [Release metadata including gitHead](https://registry.npmjs.org/axe-core/4.12.1)

The MPL-2.0 text is retained in the bundled dependency notices. CardBush has not
modified these axe-core sources. When updating or changing this dependency,
update the exact source reference and make any modified covered sources
available under MPL-2.0 as well. Other components retain their individual terms.
