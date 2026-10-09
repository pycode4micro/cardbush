import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import concurrently from 'concurrently';

const require = createRequire(import.meta.url);
const documents = createRequire(new URL('../packages/cardbush-document-tools/package.json', import.meta.url));
const runtime = createRequire(new URL('../packages/bush-runtime/package.json', import.meta.url));
const JSZip = documents('jszip');

test('concurrently retains command parsing and rejects shell comment newline injection', async () => {
  const dependency = createRequire(require.resolve('concurrently'));
  const quote = dependency('shell-quote');
  const argumentsToQuote = ['plain', 'with spaces', '$(must-stay-literal)', 'a;b', '中文'];
  assert.deepEqual(quote.parse(quote.quote(argumentsToQuote)), argumentsToQuote);
  assert.throws(() => quote.quote(['echo', { comment: 'safe' }, '\necho injected']), /line terminators/);
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const commands = ['first', 'second'].map(name => ({ name,
    command: `"${process.execPath}" -e "process.stdout.write('dependency-${name}')"` }));
  await concurrently(commands, { outputStream: output, prefix: 'none', successCondition: 'all' }).result;
  assert.match(text, /dependency-first/);
  assert.match(text, /dependency-second/);
});

test('Electron builder downloader still uses the configured proxy with global-agent 4', async t => {
  const received = [];
  const proxy = createServer((request, response) => {
    received.push({ url: request.url, host: request.headers.host });
    response.end('proxied-electron-fixture');
  });
  t.after(() => { proxy.closeAllConnections(); proxy.close(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const builder = createRequire(require.resolve('app-builder-lib/package.json'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/proxy/i.test(key)) delete env[key];
  env.GLOBAL_AGENT_HTTP_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  const child = `
    require(process.argv[1]).initializeProxy();
    require('node:http').get('http://electron-download.invalid/fixture', response => {
      response.pipe(process.stdout);
    }).on('error', error => { console.error(error); process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', child, builder.resolve('@electron/get')],
    { env, windowsHide: true, timeout: 10_000 });
  assert.equal(stdout, 'proxied-electron-fixture');
  assert.deepEqual(received, [{ url: 'http://electron-download.invalid/fixture', host: 'electron-download.invalid' }]);
});

test('ExcelJS writes and reads extended icon-set conditional formatting with upgraded UUID', async () => {
  const ExcelJS = documents('exceljs');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('条件格式');
  sheet.addRows([[10], [50], [90]]);
  sheet.addConditionalFormatting({ ref: 'A1:A3', rules: [{ type: 'iconSet', iconSet: '3Triangles',
    cfvo: [0, 33, 67].map(value => ({ type: 'percent', value })) }] });
  const bytes = await book.xlsx.writeBuffer();
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(xml, /x14:cfRule[^>]+id="\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}"/);
  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(bytes);
  assert.equal(reopened.worksheets[0].getCell('A3').value, 90);
  assert.equal(reopened.worksheets[0].conditionalFormattings[0].rules[0].iconSet, '3Triangles');
});

test('sharp renders SVG and PPTX retains the generated image and slide layout', async () => {
  const sharp = runtime('sharp');
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"><rect width="24" height="12" fill="blue"/></svg>')).png().toBuffer();
  const imageMetadata = await sharp(png).metadata();
  assert.equal(imageMetadata.width, 24);
  assert.equal(imageMetadata.height, 12);
  const PptxGenJS = documents('pptxgenjs');
  const ppt = new PptxGenJS();
  ppt.layout = 'LAYOUT_WIDE';
  const slide = ppt.addSlide();
  slide.addImage({ data: 'image/png;base64,' + png.toString('base64'), x: 1, y: 1, w: 4, h: 2 });
  const zip = await JSZip.loadAsync(await ppt.write({ outputType: 'nodebuffer' }));
  const images = zip.file(/^ppt\/media\/.*\.png$/);
  assert.equal(images.length, 1);
  assert.deepEqual(await images[0].async('nodebuffer'), png);
  assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /<p:pic>/);
  assert.match(await zip.file('ppt/slides/slide1.xml').async('string'), /<a:ext cx="3657600" cy="1828800"\/>/);
});
