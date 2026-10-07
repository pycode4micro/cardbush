// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { inspectDocument } from './inspect.mjs';
import { authorDocument, convertDocument, findOffice, renderPdf } from './jobs.mjs';
import { libraries, pdfReader } from './sdk.mjs';

async function environment(kind) {
  await libraries(kind);
  if (kind === 'docx') await import('word-extractor');
  if (kind === 'pdf') {
    const { PDFDocument } = (await libraries(kind)).PDFLib;
    const pdf = await PDFDocument.create(); pdf.addPage();
    const reader = await pdfReader(await pdf.save()); await reader.close();
  }
  return { kind, ready: true, engine: 'CardBush document tools', office: await findOffice(),
    libraries: { xlsx: ['exceljs', 'jszip', '@xmldom/xmldom'], pptx: ['pptxgenjs', 'jszip', '@xmldom/xmldom'],
      docx: ['docx', 'word-extractor', 'jszip', '@xmldom/xmldom'], pdf: ['pdf-lib', '@pdf-lib/fontkit', 'pdfjs-dist', '@napi-rs/canvas'] }[kind],
    officeRequiredFor: ['Office to PDF', 'XLSX formula recalculation', 'legacy DOC conversion'],
    note: 'Author scripts execute as code under normal tool authorization and host resource controls; the staging directory is not a security sandbox.' };
}
const [jobFile, resultFile] = process.argv.slice(2);
try {
  const { kind, action, request } = JSON.parse(await readFile(jobFile, 'utf8'));
  const result = action === 'inspect' ? await inspectDocument(kind, request)
    : action === 'author' ? await authorDocument(kind, request)
    : action === 'convert' ? await convertDocument(kind, request)
    : action === 'render' ? await renderPdf(request)
    : action === 'environment' ? await environment(kind) : (() => { throw new Error('Unsupported document action.'); })();
  await writeFile(resultFile, JSON.stringify({ ok: true, result }));
} catch (error) {
  await writeFile(resultFile, JSON.stringify({ ok: false, error: error.message, code: error.code ?? 'document_operation_failed' }));
  process.exitCode = 1;
}
