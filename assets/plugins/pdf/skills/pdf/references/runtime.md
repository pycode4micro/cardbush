# 内置 PDF 工具

author_document({code, inputs:[{path,sha256?}], outputs:[绝对路径]}) 的代码获得 tools、输入副本 inputs 和输出暂存路径 outputs。它是普通代码执行，沿用工具权限和资源保护。

```js
const { PDFDocument, StandardFonts } = tools.PDFLib;
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage([595, 842]).drawText('Project report', { x: 50, y: 770, size: 24, font });
await tools.fs.writeFile(outputs[0], await pdf.save());
```

中文使用合适的 TTF/OTF，作为输入文件传入：

```js
pdf.registerFontkit(tools.fontkit);
const font = await pdf.embedFont(await tools.fs.readFile(inputs[0]), { subset: true });
```

编辑现有 PDF 用 PDFDocument.load(await tools.fs.readFile(inputs[0]))。合并、拆分使用 copyPages 后按所需顺序添加。填写表单后使用合适字体更新外观，再保存至 outputs[0]。

render_pdf_page({path, output:绝对PNG路径, page:1, scale:1.5}) 每次渲染一页，返回图片与路径；图片很大时仅返回路径，可降低 scale。inspect_document 提取文本；实际排版和表单外观用渲染验证。真正脱敏需要移除底层内容，当前没有专用脱敏工具。
