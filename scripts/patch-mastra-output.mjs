/* global process, console */
/**
 * `mastra build` reinstalls dependencies into .mastra/output from the registry, which drops
 * our pnpm patch for @mastra/core (Studio trace list crash, see docs/PROGRESS.md). This
 * re-applies the identical one-line fix to the build output and fails if it cannot.
 */
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FROM = 'return stored == null ? buildPreview(value) : stored.trim() || null;';
const TO = 'return stored == null ? buildPreview(value) : (typeof stored === "string" ? stored : JSON.stringify(stored)).trim() || null;';

const outDir = path.resolve(process.argv[2] ?? '.mastra/output');
const coreDist = path.join(realpathSync(path.join(outDir, 'node_modules/@mastra/core')), 'dist');
let patched = 0;
let alreadyPatched = 0;
for (const file of readdirSync(coreDist)) {
  if (!/\.(c?js|mjs)$/.test(file)) continue;
  const full = path.join(coreDist, file);
  const src = readFileSync(full, 'utf8');
  if (src.includes(TO)) alreadyPatched++;
  if (!src.includes(FROM)) continue;
  writeFileSync(full, src.split(FROM).join(TO));
  patched++;
}
if (patched + alreadyPatched === 0) {
  console.error(`[patch-mastra-output] lightPreview fix not applicable in ${coreDist}; check the @mastra/core version and patches/`);
  process.exit(1);
}
console.log(`[patch-mastra-output] @mastra/core lightPreview fix: ${patched} file(s) patched, ${alreadyPatched} already patched`);
