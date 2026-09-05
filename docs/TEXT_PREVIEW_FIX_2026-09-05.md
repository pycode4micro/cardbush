# 文本预览与同类读取问题修复

## 原因与范围

截图中的 `D:/apex/artifacts/verify/test-final.txt` 是带 BOM 的 UTF-16 LE 文本。旧实现按原始字节统计 NUL 比例，把编码中的零字节误判成二进制；随后固定用 UTF-8 解码也无法正确读取。

排查覆盖 Electron 文本 IPC、文本/Office 兜底预览、本地文件协议、渲染器源码与 Markdown 预览、无 ripgrep 时的文本搜索。

## 已修复

- 两条文本预览入口共用 `electron/textPreview.ts`，先识别编码、再检查解码后的文本，支持 UTF-8 与带 BOM 的 UTF-16/32（两种字节序）。无 BOM 的 UTF-16 仅在零字节分布信号足够明确时识别。
- 去掉编码 BOM，避免 JSON 样式导入和 Markdown 解析受到不可见前缀影响。常见文本扩展名的非 UTF-8 内容可回退 GB18030，界面明确显示该编码，不承诺自动识别任意历史编码。
- 保留 2 MiB 预览限制；截断时不输出半个字符或半个代理对。损坏的完整 Unicode 文件不会静默替换成乱码。
- `electron/fileRead.ts` 累积短读，只返回实际读取的字节。文件缩短时不再解码未读取的缓冲区；本地资源与 Office 源文件响应的长度使用实际数据长度。Range 无可读内容时返回 416。
- 保留二进制签名、NUL 与控制字符检查；文本兜底页面继续转义内容，并限制脚本执行。二进制或无法可靠解码的兜底预览只展示有限十六进制数据。
- 大文本、超长行与行数过多的源码/Markdown 降级为单一纯文本区，避免大规模语法高亮或逐行 DOM。小文件原有渲染不变；切换预览清空旧内容与编码提示。
- 无 ripgrep 时的 Node 搜索支持带 BOM 的 UTF-16 LE/BE，剥离 UTF-8 BOM，并兼容 CRLF、CR、LF 换行；二进制仍跳过。

## 验证

- 原始 `test-final.txt` 只读实测：UTF-16 LE、959 字符、25 行，无 NUL/替换字符，未截断；两条预览路径正常；读取前后 SHA-256 一致。
- `npm run test:text-preview`：14 项通过，包含真实临时文件、编码/BOM、字符边界、短读、原文件不变、HTML 转义，以及生产协议处理函数的文件缩短/Range 回归。
- `workspaceTools` 测试 19 项及 `npm run test:runtime` 全部通过。
- Electron/React 实际视图测试、48 个契约脚本、前后端 TypeScript 检查及 Vite 生产构建通过。
- 新增测试已通过 `test:text-preview` 接入 `test:all` 的自动发现流程。

## 保持不变

没有转码或改写用户原文件；没有调整 `read_file`、`edit_file`、`write_file` 的显式编码约定，也没有改动对话持久化或缓存链。

Electron 主进程与运行时改动需要重新启动源码运行的 CardBush 才能生效。之前生成的 EXE 尚未重新打包，不包含本次修复。
