import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';

const guidance = 'https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images';
const titles = {
  'conversation': ['会话与行动清单', 'Conversations and actions'],
  'app-center': ['应用中心', 'App Center'],
  'browser-use': ['Chrome / Edge 连接管理', 'Chrome / Edge connections'],
  'automations': ['定时与自动化', 'Scheduled automations'],
};
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export async function packageScreenshots(output) {
  const report = JSON.parse(await fs.readFile(path.join(output, 'screenshots.json'), 'utf8'));
  assert.equal(report.screenshots.length, 8);
  assert.equal(new Set(report.screenshots.map(item => item.file)).size, 8);
  for (const locale of ['zh-CN', 'en-US']) assert.equal(report.screenshots.filter(item => item.language === locale).length, 4);
  const zip = new JSZip();
  const hashes = [];
  for (const item of report.screenshots) {
    assert.match(item.file, /^(zh-CN|en-US)\/0[1-4]-(conversation|app-center|browser-use|automations)\.png$/);
    const bytes = await fs.readFile(path.join(output, item.file));
    assert.equal(bytes.readUInt32BE(16), 1920);
    assert.equal(bytes.readUInt32BE(20), 1080);
    assert.ok(bytes.length < 50 * 1024 * 1024);
    assert.ok(item.caption.length <= 200);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    zip.file(item.file, bytes);
    hashes.push(`${item.sha256}  ${item.file}`);
  }
  const captions = report.screenshots.map(item => `| ${item.language} | ${item.file} | ${item.caption} |`).join('\n');
  const readme = `# CardBush 1.0.5.0 商店截图\n\n中英文各 4 张，共 8 张；均为 1920 × 1080 PNG。\n\n- zh-CN：上传至简体中文商店页面。\n- en-US：上传至英文商店页面。\n- 每组按文件名 01—04 排序：会话、应用中心、Browser Use、定时与自动化。\n- 配图说明在 captions.tsv，也见下表；只把 PNG 上传到“桌面截图”，不要把预览网页或 ZIP 当截图上传。\n- [打开预览](index.html)，点击图片可以查看原始尺寸。\n\n截图直接渲染当前产品的正式 React 界面组件，使用独立的中英文演示数据。会话内容、模型名称、浏览器连接状态和定时任务均为示例；未调用模型或实际运行这些任务，未读取用户配置、个人会话、网页、Cookie、配对码或密钥。界面组件没有为截图更改样式，也没有在图上叠加营销文案。这些图片用于商店介绍，不能替代安装包的端到端验证证据。\n\n尺寸、文件大小和说明长度已按[微软 MSIX 截图要求](${guidance})核对。已检查英文界面无中文残留、无渲染错误，并逐张查看画面。最终上传与认证提交由发布者完成。\n\n| 语言 | 文件 | 配图说明 |\n| --- | --- | --- |\n${captions}\n\n重新生成：在仓库目录运行 node scripts/capture-store-screenshots.mjs。脚本只使用隔离的离屏渲染器，禁止网络请求。\n`;
  const cards = report.screenshots.map(item => {
    const scene = item.file.match(/0\d-(.+)\.png$/)[1];
    const title = titles[scene][item.language === 'zh-CN' ? 0 : 1];
    return `<article data-language="${item.language}"><a href="${item.file}" target="_blank" rel="noopener"><img src="${item.file}" alt="${escape(title)}" loading="lazy" width="1920" height="1080"></a><div class="details"><span>${item.language} · ${item.file.slice(6, 8)}</span><h2>${escape(title)}</h2><p>${escape(item.caption)}</p><a class="download" href="${item.file}" download>下载原图 / Download PNG</a></div></article>`;
  }).join('\n');
  const preview = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CardBush — 商店截图 / Store screenshots</title><style>
  :root{font-family:Segoe UI,Microsoft YaHei UI,sans-serif;color:#1d2634;background:#f2f5f8}*{box-sizing:border-box}body{margin:0;padding:36px clamp(16px,4vw,72px)}header{max-width:1600px;margin:auto auto 28px}h1{font-size:28px;letter-spacing:-.5px;margin:0 0 12px}header p{color:#556476;line-height:1.6;margin:6px 0}nav{display:flex;gap:10px;margin-top:20px;flex-wrap:wrap}button,nav a{font:inherit;padding:10px 18px;border:1px solid #d1dce8;background:white;color:#273b55;border-radius:100px;cursor:pointer;text-decoration:none}button[aria-pressed=true]{background:#2457a7;color:white;border-color:#2457a7}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px;max-width:1600px;margin:auto}article{background:white;border:1px solid #dde3eb;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px #29466809}article[hidden]{display:none}img{width:100%;height:auto;display:block;border-bottom:1px solid #dde3eb}.details{padding:20px}span{font-size:12px;color:#64748b}h2{font-size:18px;margin:8px 0}article p{font-size:14px;line-height:1.6;color:#526273;min-height:44px}.download{color:#2457a7;font-size:14px}footer{max-width:1600px;margin:24px auto;color:#667589;font-size:13px;line-height:1.7}a:focus-visible,button:focus-visible{outline:3px solid #7fa9eb;outline-offset:3px}@media(max-width:850px){.grid{grid-template-columns:1fr}body{padding-top:24px}}
  </style></head><body><header><h1>CardBush · 商店截图 / Store screenshots</h1><p>1.0.5.0 · 1920 × 1080 PNG · 中英文各 4 张 / 4 screenshots per language</p><p>按 01—04 顺序上传至对应语言页面。点击图片查看原图。 / Upload in order; click any image to view it at full size.</p><nav><button aria-pressed="true" data-filter="zh-CN">简体中文</button><button aria-pressed="false" data-filter="en-US">English</button><button aria-pressed="false" data-filter="all">全部 / All 8</button><a href="CardBush-1.0.5.0-store-screenshots-zh-CN-en-US.zip" download>下载 ZIP</a></nav></header><main class="grid">${cards}</main><footer>当前正式界面组件 + 独立演示数据；不包含真实会话、配对码或密钥。<br>Actual product UI components with isolated sample data. No personal conversations, pairing codes or credentials.</footer><script>function filter(value){for(const card of document.querySelectorAll('article'))card.hidden=value!=='all'&&card.dataset.language!==value;for(const button of document.querySelectorAll('[data-filter]'))button.setAttribute('aria-pressed',button.dataset.filter===value?'true':'false')}for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>filter(button.dataset.filter));filter('zh-CN');</script></body></html>`;
  await fs.writeFile(path.join(output, 'README.zh-CN.md'), readme);
  await fs.writeFile(path.join(output, 'index.html'), preview);
  await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), hashes.join('\n') + '\n');
  for (const name of ['README.zh-CN.md', 'captions.tsv', 'screenshots.json', 'SHA256SUMS.txt']) zip.file(name, await fs.readFile(path.join(output, name)));
  // An extracted preview must not link to a ZIP that cannot contain itself.
  zip.file('index.html', preview.replace(/<a href="CardBush-[^"]+\.zip" download>下载 ZIP<\/a>/, ''));
  const archive = 'CardBush-1.0.5.0-store-screenshots-zh-CN-en-US.zip';
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  await fs.writeFile(path.join(output, archive), bytes);
  const verified = await JSZip.loadAsync(bytes, { checkCRC32: true });
  assert.equal(Object.keys(verified.files).filter(name => name.endsWith('.png')).length, 8);
  console.log(JSON.stringify({ archive: path.join(output, archive), bytes: bytes.length, pngs: 8, captions: 'under 200 characters', hashes: 'verified', zip: 'CRC verified' }));
}
