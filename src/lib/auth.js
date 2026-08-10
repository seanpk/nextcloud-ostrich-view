import bcrypt from 'bcryptjs';

/**
 * Passphrase matching.
 *
 * There is no username: Mom types one phrase and we work out who she is by
 * bcrypt-comparing it against every configured viewer. We always run all the
 * comparisons rather than returning on the first hit, so response time doesn't
 * leak which viewer matched (or how many are configured before the match).
 */

/**
 * @param {Array<{name:string,label:string,passphraseHash:string}>} viewers
 * @param {string} passphrase
 * @returns {Promise<{name:string,label:string}|null>}
 */
export async function matchViewer(viewers, passphrase) {
  if (typeof passphrase !== 'string' || passphrase === '') return null;

  const results = await Promise.all(
    viewers.map((viewer) =>
      bcrypt.compare(passphrase, viewer.passphraseHash).catch(() => false)
    )
  );

  let matched = null;
  for (let i = 0; i < viewers.length; i += 1) {
    if (results[i] && matched === null) {
      matched = { name: viewers[i].name, label: viewers[i].label };
    }
  }
  return matched;
}
