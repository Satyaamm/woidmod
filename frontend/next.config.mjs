import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read the single repo-root `.env` so the dashboard shares one env file with the
 * backend services instead of a separate `.env.local`. Next only auto-loads env
 * from this project dir, so we lift the public vars in manually. Dependency-free
 * on purpose (mirrors the control-plane's `load-env.ts`); a real shell export or CI
 * value already in `process.env` always wins over the file.
 */
function rootEnv(key) {
  if (process.env[key] !== undefined) return process.env[key];
  try {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() === key) {
        return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no file — fall through to the default */
  }
  return undefined;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * Do NOT add `antd` or `antd-style` here. Transpiling them gives the app a
   * second copy of `@ant-design/cssinjs`, so `AntdRegistry` collects styles from
   * a different cache than the components register into — the page renders with
   * zero antd CSS. `@ant-design/plots` still needs it for its ESM build.
   */
  transpilePackages: ['@ant-design/plots'],
  env: {
    NEXT_PUBLIC_API_URL: rootEnv('NEXT_PUBLIC_API_URL') ?? 'http://localhost:3101',
  },
};

export default nextConfig;
