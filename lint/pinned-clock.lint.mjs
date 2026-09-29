import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testFiles } from './test-hygiene.lint.mjs';

/**
 * Pinned clocks against real-clock fixtures. A test that evaluates at a fixed date
 * (`nowMs: Date.parse('2026-…')`) while its signed or expiring fixture takes its times from the
 * real clock (`issuedAt: new Date(Date.now() - …)`) passes until the real date moves past the
 * pinned one, then fails on every clone (the release looks issued in the future, or expired).
 * Found 2026-09-27 in route-evaluation.test.mjs.
 *
 * A test file that has both a real-clock fixture time and a pinned clock is flagged. When the
 * pinned clock is threaded through to the fixture (it is signed at that same time), the pinned
 * line, or the line above it, says so: `// pinned-clock: <how the fixture uses this clock>`.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

/** A signed or expiring fixture time taken from the real clock. */
const REAL_FIELD = /\b(?:issuedAt|expiresAt|notBefore|notAfter|validUntil|reviewedAt)\b\s*:\s*[^,}]*(?:Date\.now\(\)|new Date\(\))/;
/** A fixture builder on the real clock: `nowMs = Date.now()` whose `nowMs` makes a fixture time. */
const REAL_NOW = /\bnowMs\s*=\s*Date\.now\(\)/;
const DERIVED = /\b(?:issuedAt|expiresAt|notBefore|notAfter|validUntil)\b\s*:\s*[^,}]*\bnowMs\b/;
/** A clock pinned to a literal date. */
const PINNED = /\b(?:nowMs|now|NOW|NOW_MS|clock)\s*[:=]\s*Date\.parse\(\s*['"`]\d{4}-/;
const ALLOW = /\/\/ pinned-clock: \S/;

/** The pinned-clock lines (1-based) of one test file that mixes them with a real-clock fixture. */
export function mixedClocks(text) {
  const real = REAL_FIELD.test(text) || (REAL_NOW.test(text) && DERIVED.test(text));
  if (!real) return [];
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, index) => {
    if (!PINNED.test(line)) return;
    if (ALLOW.test(line) || (index > 0 && ALLOW.test(lines[index - 1] ?? ''))) return;
    out.push(index + 1);
  });
  return out;
}

function findings() {
  const out = [];
  for (const file of testFiles()) {
    const rel = relative(root, file).split(sep).join('/');
    for (const line of mixedClocks(readFileSync(file, 'utf8'))) out.push(`${rel}:${String(line)}`);
  }
  return out.sort();
}

test('no test pins its clock while a signed or expiring fixture runs on the real clock', () => {
  assert.deepEqual(findings(), [], 'sign the fixture at the pinned time (and mark the line // pinned-clock: <reason>), or evaluate on the real clock');
});

test('the detector flags a pinned clock beside a real-clock fixture and allows a marked or unmixed one', () => {
  const fixture = "function release() {\n  const nowMs = Date.now();\n  return { issuedAt: new Date(nowMs - 1).toISOString() };\n}\n";
  const pinned = "  const input = { nowMs: Date.parse('2026-09-26T00:00:00Z') };\n";
  assert.deepEqual(mixedClocks(fixture + pinned), [5]);
  assert.deepEqual(mixedClocks(`const a = { expiresAt: new Date(Date.now() + 1).toISOString() };\nconst NOW = Date.parse('2026-10-01T00:00:00Z');\n`), [2]);
  // Marked on the line or the line above: the fixture is signed at the pinned time.
  assert.deepEqual(mixedClocks(`${fixture}  // pinned-clock: release() is signed at this time\n${pinned}`), []);
  assert.deepEqual(mixedClocks(`${fixture}  const nowMs = Date.parse('2026-09-26T00:00:00Z'); // pinned-clock: signed at it\n`), []);
  // A pinned clock with pinned fixture times, or a real clock alone, is not mixed.
  assert.deepEqual(mixedClocks(`const NOW = Date.parse('2026-10-01T00:00:00Z');\nconst r = { issuedAt: '2026-10-01T00:00:00Z' };\n`), []);
  assert.deepEqual(mixedClocks(fixture), []);
  // The bare marker with no reason does not count.
  assert.deepEqual(mixedClocks(`${fixture}  // pinned-clock:\n${pinned}`), [6]);
});
