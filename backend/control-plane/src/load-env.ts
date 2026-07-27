/**
 * Loads the single repo-root `.env` into `process.env` — the one place a file is
 * read from disk into the environment.
 *
 * Why hand-rolled instead of `dotenv`: this is the whole feature (parse KEY=VALUE,
 * skip comments, don't clobber real env), it runs before anything else, and it keeps
 * the dependency footprint of the env boundary at zero. `config.ts` imports this at
 * the top and then validates `process.env` with Zod — nothing else touches either.
 *
 * Precedence: a variable already present in `process.env` (a real shell export, a
 * value injected by `docker`/CI) always wins over the file. The file only fills gaps,
 * so production — which sets real env and ships no `.env` — is unaffected.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/load-env.ts → repo root is three levels up (src → control-plane → backend → root).
const ROOT_ENV = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');

function parse(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of matching surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let loaded = false;

/** Idempotent: safe to import from multiple entrypoints. */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  let contents: string;
  try {
    contents = readFileSync(ROOT_ENV, 'utf8');
  } catch {
    // No file (e.g. production, or vars exported another way) is not an error —
    // config.ts validates what's present and fails loudly on anything missing.
    return;
  }
  for (const [key, value] of Object.entries(parse(contents))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Load on import so a bare `import './load-env.js'` is enough.
loadEnv();
