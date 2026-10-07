# 内置演示文稿工具

author_document 接收 code、inputs: [{path, sha256?}]、outputs: [绝对路径]。代码获得 tools、输入副本 inputs、输出暂存文件 outputs。等待所有异步写入；输出必须是新路径。适用通常的代码执行授权和资源保护。

```js
const deck = new tools.PptxGenJS();
deck.layout = 'LAYOUT_WIDE';
const slide = deck.addSlide();
slide.addText('季度回顾', { x: 0.8, y: 0.6, w: 11.7, h: 0.8, fontSize: 30 });
slide.addText('营收增长与后续计划', { x: 0.8, y: 1.8, w: 11.7, h: 1, fontSize: 20 });
await deck.writeFile({ fileName: outputs[0] });
```

tools 还包括 fs、JSZip、DOMParser、XMLSerializer。修改已有文件时加载输入副本，按 inspect_document 返回的部件路径定位文本节点，结合页面和上下文消除重复文本歧义，保留 run 样式和其他 ZIP 部件。新增页面、图表、媒体时需要同步关系文件与内容类型；无法验证时不要承诺无损。

convert_document 将 PPTX/POTX 输出成新 PDF，依赖本机 LibreOffice。PDF 插件的 render_pdf_page 可逐页查看。预览字体和动画可能与 PowerPoint 不同；结论限定在实际检查范围。
