#!/usr/bin/env node
/**
 * Generate a bcrypt hash for a viewer passphrase and print a
 * config/viewers.json-ready snippet.
 *
 *   node scripts/hash-passphrase.js
 *   node scripts/hash-passphrase.js "correct horse battery staple" mom Mom
 *
 * With no arguments it prompts (and hides the passphrase if the terminal allows).
 */
import { createInterface } from 'node:readline';
import { stdin, stdout, argv, exit } from 'node:process';

import bcrypt from 'bcryptjs';

const ROUNDS = 12;

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const isTTY = Boolean(stdin.isTTY);

    if (isTTY) {
      // Suppress echo so the passphrase doesn't end up in a screen-share.
      const onData = (char) => {
        const s = String(char);
        if (s === '\n' || s === '\r' || s === '') {
          stdin.removeListener('data', onData);
          return;
        }
        stdout.write('[2K[200D' + question + '*'.repeat(rl.line.length));
      };
      stdin.on('data', onData);
    }

    rl.question(question, (answer) => {
      rl.close();
      if (isTTY) stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const [, , passphraseArg, nameArg, labelArg] = argv;

  // Trim before hashing: the login route compares the *trimmed* input, so a
  // hash of an untrimmed phrase (say, with a pasted trailing space) could
  // never match at login.
  const passphrase = (passphraseArg ?? (await askHidden('Passphrase: '))).trim();
  if (passphrase === '') {
    console.error('A passphrase is required.');
    exit(1);
  }
  if (passphrase.length < 8) {
    console.error('Warning: that passphrase is shorter than 8 characters. Consider a longer phrase.');
  }

  const name = (nameArg ?? 'mom').trim();
  const label = (labelArg ?? name.charAt(0).toUpperCase() + name.slice(1)).trim();

  const hash = await bcrypt.hash(passphrase, ROUNDS);

  const entry = { name, label, passphraseHash: hash };

  console.log('');
  console.log('Add this entry to config/viewers.json (the file is a JSON array):');
  console.log('');
  console.log(JSON.stringify([entry], null, 2));
  console.log('');
  console.log('If the file already has viewers, add just this object to the existing array:');
  console.log('');
  console.log(JSON.stringify(entry, null, 2));
  console.log('');
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
