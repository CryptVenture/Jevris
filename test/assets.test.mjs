import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_SOURCES, driftedAssets } from '../scripts/sync-assets.mjs';
import { REQUIRED, checkPackList } from '../scripts/check-pack.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('every shipped asset is byte-equal to its source; run npm run assets:sync after editing a source (BLD-04)', () => {
  assert.deepEqual(driftedAssets(), []);
});

test('the tarball must carry the assets, and the files allowlist ships assets/ (BLD-04)', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.files.includes('assets/'), true);
  for (const [asset] of ASSET_SOURCES) assert.equal(REQUIRED.includes(asset), true, asset);
  const { missing } = checkPackList(REQUIRED.filter((path) => !path.startsWith('assets/')));
  assert.deepEqual(missing.filter((path) => path.startsWith('assets/')), ASSET_SOURCES.map(([asset]) => asset));
});

test('the runtime asset readers resolve under the package root, not ssot_docs or fixtures (BLD-03, BLD-04)', async () => {
  const { assetPath } = await import('../packages/platform/dist/index.js');
  for (const [asset] of ASSET_SOURCES) {
    const resolved = assetPath(...asset.split('/').slice(1));
    assert.equal(resolved, join(root, ...asset.split('/')));
    assert.equal(existsSync(resolved), true);
  }
  const { loadEvaluationCorpus } = await import('../packages/evals/dist/index.js');
  const shipped = await loadEvaluationCorpus();
  assert.equal(shipped.modelCount > 0, true);
});
