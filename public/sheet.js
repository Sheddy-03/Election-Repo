'use strict';
/* Minimal spreadsheet reader for the 2026 register upload (no libraries).
   - .xlsx: unzips with the browser's DecompressionStream and reads the first worksheet.
   - .csv / .txt: comma, semicolon or tab separated, quotes supported.
   Returns an array of rows, each an array of cell strings. */

async function readSpreadsheet(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.xlsx')) return readXlsx(new Uint8Array(await file.arrayBuffer()));
  if (name.endsWith('.xls')) throw new Error('Old .xls files are not supported. In Excel use File → Save As → Excel Workbook (.xlsx) or CSV.');
  return parseCsv(await file.text());
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x !== ''));
}

async function readXlsx(bytes) {
  const files = await unzip(bytes, (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml' || n.startsWith('xl/worksheets/'));
  const xml = (n) => (files[n] ? new DOMParser().parseFromString(files[n], 'application/xml') : null);
  // first sheet in workbook order
  let sheetPath = Object.keys(files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n)).sort()[0];
  const wb = xml('xl/workbook.xml'), rels = xml('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const firstSheet = wb.getElementsByTagName('sheet')[0];
    const rid = firstSheet && (firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rel = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    if (rel) { const t = rel.getAttribute('Target').replace(/^\//, ''); sheetPath = t.startsWith('xl/') ? t : 'xl/' + t; }
  }
  if (!sheetPath || !files[sheetPath]) throw new Error('Could not find a worksheet in this file.');
  const shared = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) for (const si of ss.getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
  const doc = xml(sheetPath);
  const out = [];
  for (const r of doc.getElementsByTagName('row')) {
    const row = [];
    for (const c of r.getElementsByTagName('c')) {
      const ref = c.getAttribute('r') || '';
      const col = ref.replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const t = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      let val = '';
      if (t === 's') val = shared[Number(v && v.textContent)] ?? '';
      else if (t === 'inlineStr') val = [...c.getElementsByTagName('t')].map((x) => x.textContent).join('');
      else val = v ? v.textContent : '';
      row[col >= 0 ? col : row.length] = String(val).trim();
    }
    out.push(Array.from(row, (x) => x ?? ''));
  }
  return out.filter((r) => r.some((x) => x !== ''));
}

async function unzip(bytes, want) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like a valid .xlsx file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = {};
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    if (!want(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    let raw;
    if (method === 0) raw = data;
    else if (method === 8) raw = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('Unsupported compression in this .xlsx file.');
    out[name] = dec.decode(raw);
  }
  return out;
}

/** Guess which columns hold the PU code and the registered-voter count. */
function detectRegisterColumns(rows) {
  const CODE = /^\d{2}-\d{2}-\d{2}-\d{3}$/;
  const width = Math.max(...rows.map((r) => r.length));
  const sample = rows.slice(0, 400);
  let codeCol = -1, best = 0;
  for (let c = 0; c < width; c++) { const n = sample.filter((r) => CODE.test(r[c] || '')).length; if (n > best) { best = n; codeCol = c; } }
  const headerRow = rows.findIndex((r) => r.some((x) => CODE.test(x)));
  const header = headerRow > 0 ? rows[headerRow - 1] : [];
  const isNum = (x) => /^\d[\d,]*$/.test(String(x || '').trim());
  const numericCols = [];
  for (let c = 0; c < width; c++) if (c !== codeCol && sample.filter((r) => CODE.test(r[codeCol] || '') && isNum(r[c])).length >= Math.max(1, best * 0.8)) numericCols.push(c);
  const byHeader = numericCols.find((c) => /regist|voter|pvc|total/i.test(header[c] || ''));
  return { codeCol, regCol: byHeader ?? numericCols[numericCols.length - 1] ?? -1, header, width, numericCols };
}
