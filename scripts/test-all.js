// scripts/test-all.js
// Aggregated test entrypoint (npm test): runs every module's inline SELF_TEST
// in a child process and fails nonzero if any module fails. No keys required:
// each SELF_TEST exercises its hermetic/local-mode path by design.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MODULES = [
  'src/market/ledger.js',
  'src/market/registry.js',
  'src/market/wallets.js',
  'src/market/seller.js',
  'src/buyers/verify.js',
  'src/buyers/fleet.js',
  'src/evolution/genome.js',
  'src/evolution/engine.js',
  'src/memory/actian.js',
  'src/mesh/band.js',
  'src/governance/guild.js',
  'src/publish/senso.js',
  'src/dashboard/server.js',
];

let failed = 0;
const results = [];
for (const rel of MODULES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, rel)], {
    env: { ...process.env, SELF_TEST: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const ok = r.status === 0;
  if (!ok) failed += 1;
  results.push({ rel, ok, ms: Date.now() - t0 });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${rel} (${Date.now() - t0}ms)`);
  if (!ok) {
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-6).join('\n');
    console.log(tail.replace(/^/gm, '      '));
  }
}

console.log(`\n${results.length - failed}/${results.length} module self-tests passed`);
process.exit(failed === 0 ? 0 : 1);
