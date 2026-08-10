/**
 * One-off generator for the mock server's binary fixtures.
 *
 * The three files next to this script are committed, so tests never depend on
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
 */
import { writeFileSync } from 'node:fs';
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
