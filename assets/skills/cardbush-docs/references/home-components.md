# 通过对话创建主页组件

用户可以在普通对话或 Assistant 中说「改一下主页的比赛比分卡」。任务对象是当前桌面已安装的组件。首选在工具搜索中找 `read_home_component`、`edit_home_component`、`preview_home_component`，不要修改 CardBush 源码、构建产物、单实例锁、数据库或全局网络策略，也不用启动第二个客户端。

1. 调用 `read_home_component({})`，按标题确认 ID。提供 `id` 可以分段回读 HTML；大组件用 `find` 直接定位要改的函数，或用 `offset`、`nextOffset` 翻页。
2. 用 `edit_home_component`，传 `mode:"update"`、ID 和刚读到的 `expectedRevision`。小改动传 `replacements:[{before,after}]`，每段原文须唯一匹配。新建才用 `mode:"create"`，传标题和 HTML，`home:true` 放到主页。版本冲突时重新读取后再决定如何合并。不要清库、复制出另一个同名组件或覆盖其他人的改动。
3. 回读确认修改已安装，使用 `preview_home_component({id})` 查看同一版本的沙箱截图。预览不操作用户的窗口，也不读真实组件状态或连接网络；截图不能证明实时数据已刷新。

**需要实时数据时**，在编辑参数中用 `networkDomains` 声明最多 8 个确切的 HTTPS 来源，例如 `["https://scores.example.org"]`。请用户在「组件」页点「编辑主页布局」，再点卡片的铅笔，勾选来源并保存。新来源默认不获准，Agent 修改代码后要重新授权；已有临时字段也不能当成用户授权。在主页使用 `window.cardbush.net?.fetchJson(url)`，没有该能力时显示快照或明确缺少授权。该接口只发不带凭据的 GET，要求站点允许跨域并返回 JSON，不跟随重定向。优先按可见性刷新，失败时保留带时间戳的上次数据。缺少授权、跨域支持或桌面连接时，说明限制，不得绕过。

## 从独立前端文件发布

例如，创建下面三个文件。脚本路径相对于本技能目录，示例中的源文件路径相对于命令的工作目录。请使用 Node.js 24。

`index.html`

```html
<!doctype html><html lang="zh"><meta charset="utf-8">
<label><input id="done" type="checkbox">完成今日复核</label></html>
```

`style.css`

```css
label { color: var(--cb-text); display: flex; align-items: center; gap: .5rem; }
```

`main.ts`

```ts
const input = document.querySelector<HTMLInputElement>('#done')!;
const host = (window as any).cardbush;
await host.ready;
input.checked = (await host.state.read()) === true;
input.addEventListener('change', () => host.state.write(input.checked));
```

```sh
node "<技能目录>/scripts/home-component.mjs" publish --id daily-review --title "今日复核" --html index.html --style style.css --script main.ts --home
node "<技能目录>/scripts/home-component.mjs" list
```

`--home` 将组件放到主页。新建时省略它会只存入组件库，用户可在 **组件 → 编辑主页布局 → 添加主页内容** 选择。相同 ID 更新原组件并保留其勾选等状态。列出的 `home: true` 表示已登记到该用户的主页。用户从主页移除后仍可从同一列表再次添加。编辑布局时，卡片的铅笔可直接编辑 HTML。组件库里的删除操作会删除该组件。

## 文件格式和编辑

- 在 **组件 → 编辑主页布局 → 添加主页内容 → 编写 HTML** 也可同时选择一个 HTML 和多个 CSS、JS、MJS、TS 或 MTS 文件导入，查看合并后的内容后保存。单独导入脚本时默认提供一个 `#app` 容器。
- 可直接发布带内联样式、脚本和 data 图片的 HTML。独立 CSS 用 `--style`，独立 JavaScript 模块或 TypeScript 用 `--script`，可重复传入。样式和脚本由发布命令嵌入，HTML 不需要再用外部路径加载它们。
- 使用 React、Vue、Svelte、JSX、Sass、资源文件或有模块依赖的项目时，先用项目自己的构建工具产出可独立运行的 HTML，或将依赖打包为一个浏览器 JS 文件、一个 CSS 文件并内联资源，再按上例发布。原始工程保留在用户的工作区。
- 脚本适合在组件自己的工作目录中组装多文件。通过 `export --id daily-review --output current.html` 取得当前 HTML 和版本，再用相同 ID 和 `--expected-revision <版本>` 发布；未指定的标题、尺寸和位置会保留。`--origin https://scores.example.org` 只申请来源。新卡默认 6/12 列、280 像素高。
- 脚本使用操作系统默认 CardBush 桌面配置目录。独立测试或自定义配置目录用 `--profile "<目录>"`。命令必须运行在目标桌面所在机器、对应系统用户下。远程 Agent 若只能操作远程文件系统，可交付自包含 HTML，由用户在目标桌面的 **组件 → 编辑主页布局 → 添加主页内容 → 编写 HTML** 导入。
- 组件在隔离 iframe 内运行。最多 12 个，每个打包后最多 256 KiB。交互可使用 DOM、内联脚本、`cardbush.state.read/write` 和 `--cb-*` 主题变量。外部网络、宿主文件和 Electron API 不可直接访问。发布脚本不会授予会话或浏览器动作权限，用户可在编辑器内开启。
