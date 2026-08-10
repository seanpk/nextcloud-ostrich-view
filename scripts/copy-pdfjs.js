#!/usr/bin/env node
/**
 * Copy the prebuilt pdf.js assets out of node_modules into `public/pdfjs/`,
 * where @fastify/static serves them.
 *
 * WHY A COPY AND NOT A BUNDLER: the app has no build step, and pdf.js needs its
 * worker, WASM decoders, CMaps and standard fonts fetched at runtime by URL.
 * Copying the files keeps those relative URLs intact with no tooling.
 *
 * WHAT ABOUT `web/viewer.html`: the npm package does not ship Mozilla's generic
 * viewer HTML -- that lives only in the GitHub release zip. It ships the viewer
 * *components* (`web/pdf_viewer.mjs`, the same code the generic viewer is built
 * from). So `scripts/pdfjs-viewer/` holds a ~120-line page that wires those
 * components up, and it is copied in alongside them as `web/viewer.html`. That
 * turns out to be the better fit anyway: there is no toolbar, so there are no
 * download / print / open-file buttons to hide.
 *
 * `public/pdfjs/` is gitignored and rebuilt from scratch on every run; the npm
 * `prepare` script calls this so `npm ci` produces it. `npm run pdfjs` runs it
 * on demand (Docker images that install with `--omit=dev` must do that, since
 * npm skips `prepare` in that mode).
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'pdfjs');
const SHIM = join(ROOT, 'scripts', 'pdfjs-viewer');

function pdfjsRoot() {
  try {
    // Resolve through the package's own entry point rather than guessing at a
    // node_modules layout, so hoisting/workspaces can't break this.
    return dirname(require.resolve('pdfjs-dist/package.json'));
  } catch {
    throw new Error(
      'pdfjs-dist is not installed. Run `npm install` before `npm run pdfjs`.'
    );
  }
}

/**
 * `[source relative to pdfjs-dist, destination relative to public/pdfjs]`.
 * Minified builds only: this is served to a phone over a home tunnel.
 */
const ASSETS = [
  ['build/pdf.min.mjs', 'build/pdf.min.mjs'],
  ['build/pdf.worker.min.mjs', 'build/pdf.worker.min.mjs'],
  ['web/pdf_viewer.mjs', 'web/pdf_viewer.mjs'],
  ['web/pdf_viewer.css', 'web/pdf_viewer.css'],
  // Annotation-layer icons referenced by pdf_viewer.css.
  ['web/images', 'web/images'],
  // Fetched at runtime by the worker: CJK encodings, the 14 standard fonts,
  // and the JBIG2/JPEG2000/colour-management decoders.
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs'],
  ['LICENSE', 'LICENSE'],
];

function main() {
  const source = pdfjsRoot();
  const { version } = require('pdfjs-dist/package.json');

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  for (const [from, to] of ASSETS) {
    const src = join(source, from);
    if (!existsSync(src)) {
      throw new Error(
        `pdfjs-dist ${version} has no ${from}. ` +
          'The package layout changed; update scripts/copy-pdfjs.js.'
      );
    }
    const dest = join(OUT, to);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  // Our viewer page, dropped in beside the components it uses.
  cpSync(SHIM, join(OUT, 'web'), { recursive: true });

  writeFileSync(join(OUT, 'VERSION'), `${version}\n`, 'utf8');
  console.log(`pdf.js ${version} -> public/pdfjs/`);
}

main();
