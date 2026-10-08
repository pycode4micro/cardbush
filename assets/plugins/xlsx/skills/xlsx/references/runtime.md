# 内置工作簿工具

author_document 接收 code、inputs: [{path, sha256?}]、outputs: [绝对路径]。代码获得 tools、输入副本路径 inputs 和输出暂存路径 outputs；await 全部操作后返回。它执行普通代码，适用现有工具授权和资源保护；临时目录不是安全沙箱。

tools.ExcelJS 是固定版本 ExcelJS，tools.fs 是文件 API，还有 JSZip、DOMParser、XMLSerializer。单元格、公式、字体、底色、边框、对齐、条件格式、表对象、图片和页面设置由代码自由组合，没有固定成稿样式。原生图表的能力边界见 [设计指导](design.md)。下面仅演示文件接口，不是报告模板。示例 code：

```js
const book = new tools.ExcelJS.Workbook();
const sheet = book.addWorksheet('销售');
sheet.addRows([['项目', '金额'], ['产品 A', 120], ['产品 B', 80]]);
sheet.getCell('B4').value = { formula: 'SUM(B2:B3)' };
sheet.getColumn(1).width = 24;
sheet.getColumn(2).numFmt = '#,##0.00';
await book.xlsx.writeFile(outputs[0]);
```

修改普通文件先 await book.xlsx.readFile(inputs[0])，只修改指定区域。ExcelJS 不保证复杂 Excel 特性无损往返；必要时定点修改 OOXML，保留未知部件。公式不能由模型手算后伪装成引擎结果。

convert_document({path, output, expected_sha256?}) 输出 XLSX 时用已有 LibreOffice 重算，输出 PDF 时用于预览。已有输出拒绝覆盖；错误单元格或缺失缓存阻止重算文件发布。业务逻辑正确性仍需核对。document_environment 返回引擎是否可用，可用 CARDBUSH_SOFFICE 配置其绝对路径。

读取 start_column 是从 1 开始的 Excel 列号，每次最多 40 列；offset 是已填充行的序号。values 保留序列化精度。回执区分结构、计算、视觉状态，不将写入成功解释为全部验收成功。
