// Serving hosts (design 3.2, R35; owner decisions 8c1f85d and c8e933d): the pinned hosts and the
// gateway maker slugs are frozen, host ids never collide with a maker id, and every slug names a
// pinned maker. A registry override can name these hosts, never add or relabel one.
import test from 'node:test';
import assert from 'node:assert/strict';

const c = await import('../dist/index.js');

test('the pinned hosts are exactly OpenRouter, the Kilo Gateway and NVIDIA, with their harness segments', () => {
  assert.deepEqual(c.SERVING_HOSTS.map((h) => h.id), [...c.SERVING_HOST_IDS]);
  assert.deepEqual(c.SERVING_HOSTS.map((h) => [h.id, h.kind, { ...h.segments }]), [
    ['openrouter', 'gateway', { kilocode: 'openrouter', opencode: 'openrouter' }],
    ['kilo', 'gateway', { kilocode: 'kilo' }],
    ['nvidia', 'inference-host', { kilocode: 'nvidia', opencode: 'nvidia' }],
  ]);
  for (const host of c.SERVING_HOSTS) {
    assert.notEqual(host.kind, 'maker', 'a maker is its own host and is never listed');
    assert.ok(c.SERVING_HOST_KINDS.includes(host.kind));
    for (const harness of Object.keys(host.segments)) assert.ok(c.HARNESS_IDS.includes(harness), `${host.id}: ${harness}`);
  }
  assert.equal(c.servingHostOf('openrouter')?.kind, 'gateway');
  assert.equal(c.servingHostOf('moonshot'), undefined, 'a maker id is not a pinned host');
  assert.equal(c.servingHostOf('vercel'), undefined, 'a recognised but unpinned host fails closed');
});

test('host ids and host segments are disjoint from maker ids and from the maker consent texts', () => {
  for (const id of c.SERVING_HOST_IDS) {
    assert.ok(!c.PROVIDER_IDS.includes(id), `${id} is a maker id`);
    assert.ok(!Object.hasOwn(c.PROVIDER_CONSENT_TEXT, id), `${id} has a maker consent text`);
  }
  // B's LOW 17: the resolver tries a maker endpoint before a host row, so a host segment equal to a
  // maker id would read a host route as direct and skip the host's consent. (Core pins the same
  // for the maker endpoint aliases.)
  for (const host of c.SERVING_HOSTS) {
    for (const segment of Object.values(host.segments)) assert.ok(!c.PROVIDER_IDS.includes(segment), `${host.id}: ${segment} is a maker id`);
  }
});

test('every gateway maker slug maps to a pinned maker', () => {
  assert.deepEqual({ ...c.HOST_MAKER_SEGMENTS }, {
    moonshotai: 'moonshot',
    'z-ai': 'zai',
    'x-ai': 'xai',
    deepseek: 'deepseek',
    'deepseek-ai': 'deepseek',
    google: 'google',
    openai: 'openai',
    anthropic: 'anthropic',
  });
  for (const maker of Object.values(c.HOST_MAKER_SEGMENTS)) assert.ok(c.PROVIDER_IDS.includes(maker), maker);
  assert.equal(c.hostMakerOf('z-ai'), 'zai');
  assert.equal(c.hostMakerOf('meta-llama'), null);
  assert.equal(c.hostMakerOf('constructor'), null, 'no prototype key reads as a slug');
  assert.equal(c.hostMakerOf('__proto__'), null);
});

test('forwarding names only other pinned hosts, with no cycle: the Kilo Gateway forwards to OpenRouter', () => {
  assert.deepEqual(Object.fromEntries(c.SERVING_HOSTS.map((h) => [h.id, [...h.forwardsTo]])), { openrouter: [], kilo: ['openrouter'], nvidia: [] });
  for (const host of c.SERVING_HOSTS) {
    assert.ok(Array.isArray(host.forwardsTo), `${host.id} has the field`);
    for (const to of host.forwardsTo) {
      assert.ok(c.SERVING_HOST_IDS.includes(to), `${host.id} forwards to an unpinned ${to}`);
      assert.notEqual(to, host.id, `${host.id} forwards to itself`);
    }
    // No cycle: following forwardsTo from any host never comes back to it.
    const seen = new Set();
    const stack = [...host.forwardsTo];
    while (stack.length > 0) {
      const next = stack.pop();
      assert.notEqual(next, host.id, `${host.id} is in a forwarding cycle`);
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(c.servingHostOf(next)?.forwardsTo ?? []));
    }
  }
});

test('the pins are frozen all the way down', () => {
  assert.ok(Object.isFrozen(c.SERVING_HOSTS));
  for (const host of c.SERVING_HOSTS) {
    assert.ok(Object.isFrozen(host), host.id);
    assert.ok(Object.isFrozen(host.segments), host.id);
    assert.ok(Object.isFrozen(host.forwardsTo), host.id);
  }
  assert.ok(Object.isFrozen(c.HOST_MAKER_SEGMENTS));
  assert.throws(() => {
    'use strict';
    c.HOST_MAKER_SEGMENTS['meta-llama'] = 'meta';
  }, TypeError);
  assert.throws(() => c.SERVING_HOSTS.push({ id: 'vercel', kind: 'gateway', segments: {} }), TypeError);
  assert.throws(() => {
    c.SERVING_HOSTS[0].segments.codex = 'openrouter';
  }, TypeError);
});
