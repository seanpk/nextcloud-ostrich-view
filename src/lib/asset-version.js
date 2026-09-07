import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * The `?v=` on every `/public/` asset a template links to.
 *
 * It is a hash of the assets THEMSELVES, and that is the whole point.
 *
 * `/public/` is served with `maxAge: 7d` in production and the HTML is
 * `no-store`, so a phone that has been here before fetches the new markup and
 * keeps whatever stylesheet and scripts it already has -- for a week -- unless
 * the query string it asks under changes. This used to be `package.json`'s
 * `version`, which had sat at 0.1.0 since the first commit: three deploys'
 * worth of new markup went out under a `?v=` that never moved, and any phone
 * that had loaded a page in the previous week would have kept the stylesheet
 * that went with the older markup. (That is NOT what caused the enormous icons
 * reported from a phone -- the live stylesheet turned out to be the current
 * one. It is a loaded gun that had simply not gone off.)
 *
 * A version somebody has to remember to bump cannot be trusted with a 7-day
 * cache, so the number is no longer ours to forget: change a byte of CSS or JS
 * and the URL changes with it; change nothing and it does not, so the cache
 * keeps working exactly as intended.
 *
 * Cheap enough to do at boot (a few hundred KB, once) and worth far more than
 * it costs.
 *
 * @param {string[]} dirs Directories to hash, non-recursively. Files only:
 *   sub-directories are skipped, which is what keeps the generated
 *   `public/pdfjs/` tree (hundreds of files, and never referenced with a `?v=`)
 *   out of it.
 * @returns {string} 12 hex characters, or -- if anything at all is unreadable
 *   -- the current time, which still busts the cache. It just also does so on
 *   every restart instead of only when an asset really changed.
 */
export function computeAssetVersion(dirs) {
  try {
    const hash = createHash('sha256');
    for (const [index, dir] of dirs.entries()) {
      // Sorted: readdir order is the filesystem's business, and a version that
      // depends on it would differ between the build host and the container.
      const names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();

      for (const name of names) {
        // The name as well as the bytes, and a separator between them, so that
        // renaming a file changes the version and no concatenation of names and
        // contents can collide with another. The directory is identified by its
        // position in `dirs` rather than by its path: the same tree hashes the
        // same on the build host and in the container, where it is mounted
        // somewhere else entirely.
        hash.update(`${index}/${name}\0`);
        hash.update(readFileSync(join(dir, name)));
        hash.update('\0');
      }
    }
    return hash.digest('hex').slice(0, 12);
  } catch {
    return String(Date.now());
  }
}

export default computeAssetVersion;
