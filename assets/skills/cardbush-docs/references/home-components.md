# 通过对话创建主页组件

用户可以在普通对话中说「做一个可以勾选的清单，放到主页」。主页组件区的 **＋ → 通过对话创建** 会准备一条可编辑的请求。先按用户要求在工作目录创建前端文件，再运行本技能随附的发布脚本，读取发布回执。桌面和脚本共用当前系统用户的本机组件库，主页打开时会自动刷新。

## 创建和放置

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

`--home` 将组件放到主页。新建时省略它会只存入组件库，用户可在主页点 **＋** 选择。相同 ID 更新原组件并保留其勾选等状态。列出的 `home: true` 表示已登记到该用户的主页。用户从主页移除后仍可从 **＋** 再次添加。组件卡片的铅笔可直接编辑 HTML。组件库里的删除操作会删除该组件。

## 文件格式和编辑

- 主页点 **＋ → 自定义组件** 也可同时选择一个 HTML 和多个 CSS、JS、MJS、TS 或 MTS 文件导入，查看合并后的内容后保存。单独导入脚本时默认提供一个 `#app` 容器。
- 可直接发布带内联样式、脚本和 data 图片的 HTML。独立 CSS 用 `--style`，独立 JavaScript 模块或 TypeScript 用 `--script`，可重复传入。样式和脚本由发布命令嵌入，HTML 不需要再用外部路径加载它们。
- 使用 React、Vue、Svelte、JSX、Sass、资源文件或有模块依赖的项目时，先用项目自己的构建工具产出可独立运行的 HTML，或将依赖打包为一个浏览器 JS 文件、一个 CSS 文件并内联资源，再按上例发布。原始工程保留在用户的工作区。
- 要编辑已存在的组件，可先 `list` 核对 ID，再用 `export --id daily-review --output current.html` 取得当前 HTML，用相同 ID 发布修改。默认卡片宽度为 6/12 列，高 280 像素，`--width` 可取 3–12，`--height` 可取 120–1200。窄主页自动使用整行。
- 脚本使用操作系统默认 CardBush 桌面配置目录。独立测试或自定义配置目录用 `--profile "<目录>"`。命令必须运行在目标桌面所在机器、对应系统用户下。远程 Agent 若只能操作远程文件系统，可交付自包含 HTML，由用户在目标主页 **＋ → 自定义组件** 导入。
- 组件在隔离 iframe 内运行。最多 12 个，每个打包后最多 256 KiB。交互可使用 DOM、内联脚本、`cardbush.state.read/write` 和 `--cb-*` 主题变量。外部网络、宿主文件和 Electron API 不可直接访问。发布脚本不会授予会话或浏览器动作权限，用户可在编辑器内开启。
