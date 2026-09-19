// Spawns the REAL built server once for the whole e2e run.
//
// Deliberately hard-fails on a stale or missing build instead of testing
// whatever dist/ happens to hold: a suite that silently exercises last week's
// server is worse than no suite, because it reports green for code that is not
// running anywhere.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const E2E_PORT = 31998;

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

export default async function globalSetup(): Promise<void> {
  const root = process.cwd();
  const serverDir = join(root, 'server');
  const entry = join(serverDir, 'dist', 'index.js');

  if (!existsSync(join(serverDir, 'node_modules'))) {
    throw new Error('server/node_modules is missing — run `npm --prefix server ci` first');
  }
  if (!existsSync(entry)) {
    throw new Error('server/dist/index.js is missing — run `npm --prefix server run build` first');
  }
  if (statSync(entry).mtimeMs < newestMtime(join(serverDir, 'src'))) {
    throw new Error('server/dist is older than server/src — run `npm --prefix server run build` first');
  }

  const child = spawn(process.execPath, [entry], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(E2E_PORT),
      // Valid 64-hex key so the legacy encrypted-blob path imports cleanly. The
      // tiered path this suite exercises never uses it.
      ENCRYPTION_KEY: 'a'.repeat(64),
      // Forwarding headers are never sent here; keeping trust off matches the
      // default deployment and keeps every request in one honest bucket.
      TRUST_PROXY: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 10s')), 10_000);
    child.stdout?.on('data', (buf: Buffer) => {
      if (buf.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr?.on('data', (buf: Buffer) => process.stderr.write('[server] ' + buf.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('server exited before listening, code ' + code +
        ' (is port ' + E2E_PORT + ' already in use?)'));
    });
  });

  (globalThis as any).__PROXCHAT_SERVER_PROC__ = child;
}

export type { ChildProcess };
