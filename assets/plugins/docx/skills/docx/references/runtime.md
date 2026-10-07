# 内置 Word 工具

author_document({code, inputs:[{path,sha256?}], outputs:[绝对路径]}) 提供输入副本、输出暂存路径，禁止覆盖已有输出。脚本使用通常的代码执行权限，运行于资源受控的独立进程。

```js
const { Document, Paragraph, TextRun, HeadingLevel, Packer } = tools.docx;
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: '项目报告', heading: HeadingLevel.HEADING_1 }),
  new Paragraph({ children: [new TextRun('本期工作与后续计划。')] })
] }] });
await tools.fs.writeFile(outputs[0], await Packer.toBuffer(doc));
```

tools 同时提供 fs、JSZip、DOMParser、XMLSerializer。docx 库主要用于新建；编辑现有文件时用 JSZip 加载 inputs[0]，定点修改 word/document.xml 的文本节点，保留段落、run 属性和其他部件。表格、批注、修订涉及额外关系与标识，不删除不认识的 XML。

inspect_document 的段落 index 对应正文中顺序排列的 w:p，含表格内段落；仅对该 SHA-256 版本有效。被截断的内容可在执行进程中读取完整部件。

convert_document({path, output, expected_sha256?}) 输出 PDF 或 DOCX，使用已有 LibreOffice。再用 PDF 插件查看页面。结构可读不证明和 Microsoft Word 的排版完全一致。
