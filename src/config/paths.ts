import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const PACKAGE_NAME = 'leadrescue-ai';

/**
 * Resolves the repository root by walking up from the current working directory.
 *
 * `mastra dev` executes a bundle from `.mastra/output`, so relative paths such as
 * `./data/app.db` would otherwise resolve to different files depending on which
 * process opened them. Every process must agree on the same database files.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  if (process.env.LEADRESCUE_ROOT) return path.resolve(process.env.LEADRESCUE_ROOT);
  let dir = path.resolve(start);
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === PACKAGE_NAME) return dir;
      } catch {
        // Ignore unreadable package.json files and keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function resolveFromRoot(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}
