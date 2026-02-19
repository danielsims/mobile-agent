#!/usr/bin/env node
// Ensures node-pty's spawn-helper binary has execute permissions.
// pnpm extracts prebuilt binaries without preserving file modes,
// which causes posix_spawnp to hang on macOS/Linux.

import { readdirSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  const ptyDir = dirname(require.resolve('node-pty/package.json'));
  const prebuildsDir = join(ptyDir, 'prebuilds');

  let fixed = 0;
  let platforms;
  try {
    platforms = readdirSync(prebuildsDir);
  } catch {
    process.exit(0);
  }

  for (const platform of platforms) {
    const helperPath = join(prebuildsDir, platform, 'spawn-helper');
    try {
      const stat = statSync(helperPath);
      if (stat.isFile() && !(stat.mode & 0o111)) {
        chmodSync(helperPath, 0o755);
        fixed++;
      }
    } catch {
      // spawn-helper doesn't exist for this platform (e.g. Windows)
    }
  }

  if (fixed > 0) {
    console.log(`[fix-node-pty] Fixed execute permissions on ${fixed} spawn-helper binary(ies)`);
  }
} catch {
  // node-pty not installed yet — skip silently
}
