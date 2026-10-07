// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, extname, resolve } from 'node:path';
import JSZip from 'jszip';
import { DOMParser } from '@xmldom/xmldom';

export const formats = { xlsx: ['.xlsx'], pptx: ['.pptx', '.potx'], docx: ['.docx', '.doc'], pdf: ['.pdf'] };
export function absolute(value) {
  if (!isAbsolute(value)) throw new Error('Use an absolute file path.');
  return resolve(value);
}
export function assertFormat(kind, file) {
  if (!formats[kind]?.includes(extname(file).toLowerCase())) throw new Error(`This plugin accepts ${formats[kind]?.join(', ')}. Convert legacy or macro-enabled formats explicitly first.`);
}
export async function fingerprint(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function fileBytes(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('The path is not a regular file.');
  if (info.size > 128 * 1024 * 1024) throw new Error('Document exceeds this in-memory operation budget (128 MiB). Use a streaming workflow for this file.');
  return readFile(file);
}
export function xml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('DTD/entity declarations are not accepted in documents.');
  return new DOMParser({ onError: level => { if (level !== 'warning') throw new Error('Malformed document XML.'); } }).parseFromString(text, 'application/xml');
}
export function elements(document, localName) {
  return [...document.getElementsByTagNameNS('*', localName)];
}
export async function officePackage(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    total += entry._data?.uncompressedSize ?? 0;
    if (total > 256 * 1024 * 1024 || (entry._data?.uncompressedSize ?? 0) > 64 * 1024 * 1024) throw new Error('Expanded document exceeds the inspection memory budget.');
    if (entry.unsafeOriginalName && entry.unsafeOriginalName !== entry.name) throw new Error('Unsafe document part path.');
  }
  if (Object.keys(zip.files).length > 20000) throw new Error('Too many document parts.');
  if (!zip.file('[Content_Types].xml')) throw new Error('Missing Office package content types.');
  return zip;
}
export async function part(zip, name) {
  const item = zip.file(name);
  if (!item) throw new Error(`Missing document part: ${name}`);
  return xml(await item.async('string'));
}
export async function safeForOfficeConversion(zip) {
  const names = Object.keys(zip.files);
  if (names.some(name => /vbaProject|\/embeddings\/|_xmlsignatures|externalLinks|connections\.xml|queryTables/i.test(name))) {
    throw new Error('Conversion of macros, embedded objects, external data connections or signed documents is unsupported; the original is preserved.');
  }
  for (const name of names.filter(name => name.endsWith('.rels'))) {
    for (const rel of elements(await part(zip, name), 'Relationship')) {
      if (rel.getAttribute('TargetMode') === 'External' && !rel.getAttribute('Type').endsWith('/hyperlink')) {
        throw new Error('Conversion would load external document content; use the original application.');
      }
    }
  }
}
