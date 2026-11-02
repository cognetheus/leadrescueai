/**
 * Creates `.env` from `.env.example`, generating local secrets.
 * Never overwrites an existing `.env` unless `--force` is passed.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../src/config/paths';

const root = findProjectRoot();
const target = path.join(root, '.env');
if (existsSync(target) && !process.argv.includes('--force')) {
  console.log('.env already exists; leaving it unchanged (use --force to regenerate).');
  process.exit(0);
}
const template = readFileSync(path.join(root, '.env.example'), 'utf8');
const output = template
  .replace(/__GENERATE_KEY__/g, () => randomBytes(32).toString('base64'))
  .replace(/__GENERATE__/g, () => randomBytes(24).toString('base64url'));
writeFileSync(target, output, { mode: 0o600 });
console.log(`Wrote ${target} with freshly generated secrets.`);
