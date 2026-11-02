/**
 * Creates an env file from `.env.example`, generating local secrets.
 *
 *   pnpm setup:env                      -> ./.env
 *   tsx scripts/setup-env.ts --out FILE -> FILE (used by the Docker `init` service)
 *
 * Never overwrites an existing file unless `--force` is passed, so secrets stay stable
 * across restarts (credentials in the database are encrypted with them).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from '../src/config/paths';

const root = findProjectRoot();
const outFlag = process.argv.indexOf('--out');
const target = outFlag > -1 ? path.resolve(process.argv[outFlag + 1]!) : path.join(root, '.env');
if (existsSync(target) && !process.argv.includes('--force')) {
  console.log(`${target} already exists; leaving it unchanged (use --force to regenerate).`);
  process.exit(0);
}
const template = readFileSync(path.join(root, '.env.example'), 'utf8');
const output = template
  .replace(/__GENERATE_KEY__/g, () => randomBytes(32).toString('base64'))
  .replace(/__GENERATE__/g, () => randomBytes(24).toString('base64url'));
mkdirSync(path.dirname(target), { recursive: true });
writeFileSync(target, output, { mode: 0o600 });
console.log(`Wrote ${target} with freshly generated secrets.`);
