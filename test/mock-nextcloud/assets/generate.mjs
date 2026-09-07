/**
 * One-off generator for the mock server's binary fixtures.
 *
 * The five files next to this script are committed, so tests never depend on
 * a browser being installed. This script exists so their provenance is obvious
 * and so they can be regenerated:
 *
 *     node test/mock-nextcloud/assets/generate.mjs
 *
 * The PDF is built by hand (below) rather than by a library, because we need
 * exact control over its size: it is deliberately padded past pdf.js's 64 KB
 * range-chunk threshold so the E2E run really exercises `Range`/206 handling in
 * `/content/*`. The raster images come out of Chromium's canvas encoders --
 * hand-rolling a baseline JPEG encoder to produce one fixture would be silly.
 * The office files at the bottom are hand-built too, and for the same reason as
 * the PDF -- see the comment above them.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));

// --- PDF -------------------------------------------------------------------

function pdfEscape(text) {
  return text.replace(/([\\()])/g, '\\$1');
}

function contentStream(lines) {
  const body = lines
    .map(({ text, size, x, y }) => `BT /F1 ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`)
    .join('\n');
  return `${body}\n`;
}

/**
 * A two-page PDF, Helvetica text only, padded to `minBytes` with an
 * unreferenced stream object (ignored by every reader, counted by every
 * Content-Length).
 */
function buildPdf({ minBytes = 220_000 } = {}) {
  const page1 = contentStream([
    { text: 'Ostrich Test Document', size: 28, x: 72, y: 700 },
    { text: 'Week 1 lecture notes.', size: 14, x: 72, y: 660 },
  ]);
  const page2 = contentStream([{ text: 'Second page', size: 28, x: 72, y: 700 }]);

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${page1.length} >>\nstream\n${page1}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    `<< /Length ${page2.length} >>\nstream\n${page2}endstream`,
  ];

  const assemble = (objs) => {
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const offsets = [];
    objs.forEach((body, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xrefOffset = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      out += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    out +=
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;
    return out;
  };

  // First pass tells us how much padding is needed; the padding object goes
  // last so adding it cannot move any offset we already wrote.
  const bare = assemble(objects);
  const padLength = Math.max(0, minBytes - bare.length - 200);
  const padded = assemble([...objects, `<< /Length ${padLength} >>\nstream\n${' '.repeat(padLength)}\nendstream`]);

  return Buffer.from(padded, 'latin1');
}

writeFileSync(join(HERE, 'sample.pdf'), buildPdf());

// --- PNG / JPEG ------------------------------------------------------------

const DRAW = `(canvas) => {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#dceefb');
  sky.addColorStop(1, '#f7fbff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#2f6f4e';
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, Math.min(width, height) * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1c3f5e';
  ctx.lineWidth = 6;
  ctx.strokeRect(12, 12, width - 24, height - 24);
  ctx.fillStyle = '#1c3f5e';
  ctx.font = 'bold 22px sans-serif';
  ctx.fillText('OSTRICH', 24, height - 28);
}`;

async function renderImages() {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<canvas id="c" width="480" height="320"></canvas>');
    for (const [file, mime, quality] of [
      ['sample.png', 'image/png', undefined],
      ['sample.jpg', 'image/jpeg', 0.82],
    ]) {
      const dataUrl = await page.evaluate(
        ([draw, type, q]) => {
          const canvas = document.getElementById('c');
          // eslint-disable-next-line no-eval
          eval(`(${draw})`)(canvas);
          return canvas.toDataURL(type, q);
        },
        [DRAW, mime, quality]
      );
      writeFileSync(join(HERE, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  } finally {
    await browser.close();
  }
}

await renderImages();
console.log('wrote sample.pdf, sample.png, sample.jpg');

// --- DOCX / XLSX -----------------------------------------------------------

/*
 * The office fixtures are hand-built OOXML, for the same reason the PDF above
 * is hand-built: it keeps them tiny, keeps their contents exactly what the
 * tests assert on, and adds nothing to package.json. An OOXML file is a ZIP of
 * XML parts, and a ZIP with everything stored uncompressed is short enough to
 * write here (`storedZip` below) -- jszip, which mammoth reads the .docx with,
 * is perfectly happy with stored entries.
 *
 * sample.docx exercises everything the converter is supposed to preserve: a
 * Heading 1, a paragraph with bold and italic runs, a three-item bullet list,
 * an embedded PNG, and a 2x2 table. sample.xlsx exists only to be downloaded --
 * a valid, openable workbook for the "we can't show this one, here is the
 * original" path.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * A ZIP archive with every entry stored (method 0), which is all an OOXML
 * reader needs. Timestamps are fixed so regenerating the fixture twice gives
 * byte-identical files and `git status` stays quiet.
 *
 * @param {Array<[string, Buffer|string]>} entries [name, contents]
 */
function storedZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const [name, contents] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    nameBytes.copy(local, 30);

    const header = Buffer.alloc(46 + nameBytes.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);
    nameBytes.copy(header, 46);

    locals.push(local, data);
    central.push(header);
    offset += local.length + data.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, directory, end]);
}

/** An 8x8 solid-colour PNG, built the same way -- IHDR, one IDAT, IEND. */
function tinyPng({ size = 8, rgb = [0x2f, 0x6f, 0x4e] } = {}) {
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type: truecolour
  // compression, filter and interlace are all zero.

  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function buildDocx() {
  // Heading 1 has to exist in styles.xml under that exact w:name: mammoth's
  // default style map matches on the style's *name*, not on its id.
  const styles =
    `${XML}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>' +
    '</w:styles>';

  // numbering.xml is what tells mammoth this numId is bullets rather than
  // numbers, which is the difference between a <ul> and an <ol>.
  const numbering =
    `${XML}<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">' +
    '<w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '</w:numbering>';

  const bullet = (text) =>
    '<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr>' +
    '<w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>' +
    `<w:r><w:t>${text}</w:t></w:r></w:p>`;

  const cell = (text) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

  const picture =
    '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
    '<wp:extent cx="457200" cy="457200"/>' +
    '<wp:docPr id="1" name="Picture 1" descr="A chloroplast, sketched in green"/>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="0" name="chloroplast.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="457200" cy="457200"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';

  const document =
    `${XML}<w:document ` +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' +
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
    '<w:r><w:t>Week 3 &#8212; Photosynthesis</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t xml:space="preserve">Chlorophyll absorbs light at the </w:t></w:r>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t>blue</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve"> and </w:t></w:r>' +
    '<w:r><w:rPr><w:i/></w:rPr><w:t>red</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve"> ends of the spectrum.</w:t></w:r></w:p>' +
    bullet('Light reactions happen in the thylakoid membrane') +
    bullet('The Calvin cycle happens in the stroma') +
    bullet('Bring the handout to the lab on Thursday') +
    picture +
    '<w:tbl>' +
    `<w:tr>${cell('Pigment')}${cell('Light absorbed')}</w:tr>` +
    `<w:tr>${cell('Chlorophyll a')}${cell('Blue-violet')}</w:tr>` +
    '</w:tbl>' +
    '</w:body></w:document>';

  const wordml = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

  return storedZip([
    [
      '[Content_Types].xml',
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ' +
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Default Extension="png" ContentType="image/png"/>' +
        `<Override PartName="/word/document.xml" ContentType="${wordml}.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="${wordml}.styles+xml"/>` +
        `<Override PartName="/word/numbering.xml" ContentType="${wordml}.numbering+xml"/>` +
        '</Types>',
    ],
    [
      '_rels/.rels',
      `${XML}<Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="word/document.xml"/>` +
        '</Relationships>',
    ],
    [
      'word/_rels/document.xml.rels',
      `${XML}<Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_TYPE}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="${REL_TYPE}/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId3" Type="${REL_TYPE}/image" Target="media/image1.png"/>` +
        '</Relationships>',
    ],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/numbering.xml', numbering],
    ['word/media/image1.png', tinyPng()],
  ]);
}

function buildXlsx() {
  const sheetml = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

  const cell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

  return storedZip([
    [
      '[Content_Types].xml',
      `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ' +
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        `<Override PartName="/xl/workbook.xml" ContentType="${sheetml}.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${sheetml}.worksheet+xml"/>` +
        '</Types>',
    ],
    [
      '_rels/.rels',
      `${XML}<Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      `${XML}<workbook xmlns="${main}" xmlns:r="${REL_TYPE}">` +
        '<sheets><sheet name="Marks" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      `${XML}<Relationships xmlns="${REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_TYPE}/worksheet" Target="worksheets/sheet1.xml"/>` +
        '</Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `${XML}<worksheet xmlns="${main}"><sheetData>` +
        `<row r="1">${cell('A1', 'Assignment')}${cell('B1', 'Mark')}</row>` +
        `<row r="2">${cell('A2', 'Lab 1')}${cell('B2', '86')}</row>` +
        '</sheetData></worksheet>',
    ],
  ]);
}

writeFileSync(join(HERE, 'sample.docx'), buildDocx());
writeFileSync(join(HERE, 'sample.xlsx'), buildXlsx());
console.log('wrote sample.docx, sample.xlsx');
