import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';


// C33: suggest an applicable installed skill plus none, and do not execute skill code.
// C34: return one bounded original inside scope, and do not upload the repository.
// C05: an unread id stays missing. It is not proof a behavior is absent.
// R07: retrieval returns the in-scope span and does not execute an unknown skill.
const { shortlistInstalledSkills, shortlistEvidence, formatShortlist } = await import('../dist/index.js');

const BODY_LINE = 'BODY_LINE_not_a_description';
const FIXTURE_TEXT = 'export const n = 1;';
const FIXTURE_BYTES = new TextEncoder().encode(FIXTURE_TEXT);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('one installed skill includes none and one in-scope span stays missing when unread', async () => {
  const skillCalls = [];
  let evaluateCalls = 0;
  const skills = await shortlistInstalledSkills({
    roots: ['/approved/skills'],
    intent: 'use route',
    requestedIds: [],
    reader: {
      listDirectories(root) {
        skillCalls.push(['list', root]);
        return ['route'];
      },
      readSkillMarkdown(root, directoryName) {
        skillCalls.push(['read', root, directoryName]);
        const text = `---\nname: route\ndescription: Route advice\n---\n${BODY_LINE}\n`;
        return new TextEncoder().encode(text);
      },
    },
    evaluate() {
      evaluateCalls += 1;
    },
  });

  assert.deepEqual(skills.options, ['route', 'none']);
  assert.equal(skills.selected, 'route');
  assert.equal(skills.executed, false);
  assert.deepEqual(skills.unknownRejected, []);
  const route = skills.inventory.find((entry) => entry.id === 'route');
  assert.ok(route);
  assert.equal(route.description, 'Route advice');
  assert.equal(route.description.includes(BODY_LINE), false);
  assert.equal(JSON.stringify(skills).includes(BODY_LINE), false);
  assert.equal(evaluateCalls, 0);
  for (const call of skillCalls) {
    assert.equal(String(call[2] ?? '').includes('scripts'), false);
    assert.equal(String(call[1]).includes('scripts'), false);
  }

  const evidenceCalls = [];
  const evidence = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['src/app.ts', 'gone.ts'],
    intent: 'use route',
    reader: {
      readPrefix(root, relativeId) {
        evidenceCalls.push([root, relativeId]);
        if (relativeId === 'src/app.ts') return { bytes: FIXTURE_BYTES, truncated: false };
        if (relativeId === 'gone.ts') return null;
        return null;
      },
    },
  });

  assert.equal(evidence.spans.length, 1);
  assert.equal(evidence.spans[0].id, 'src/app.ts');
  assert.equal(evidence.spans[0].sha256, sha256(FIXTURE_BYTES));
  assert.equal(evidence.spans[0].byteLength, FIXTURE_BYTES.byteLength);
  assert.equal(FIXTURE_BYTES.byteLength, 19);
  assert.equal(evidence.spans[0].truncated, false);
  assert.equal(evidence.uploaded, false);
  assert.equal(evidence.missing.length, 1);
  assert.equal(evidence.missing[0].id, 'gone.ts');
  assert.equal(evidence.missing[0].state, 'missing');
  assert.equal(JSON.stringify(evidence).includes('absent'), false);
  assert.deepEqual(evidenceCalls, [
    ['/approved/repo', 'src/app.ts'],
    ['/approved/repo', 'gone.ts'],
  ]);

  let escapeCalls = 0;
  const escaped = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['../.env'],
    intent: '',
    reader: {
      readPrefix() {
        escapeCalls += 1;
        return { bytes: FIXTURE_BYTES, truncated: false };
      },
    },
  });
  assert.equal(escapeCalls, 0);
  assert.equal(escaped.uploaded, false);
  assert.equal(escaped.spans.length, 0);
  assert.equal(escaped.missing.length, 1);
  assert.equal(escaped.missing[0].id, '../.env');
  assert.equal(escaped.missing[0].state, 'missing');

  let absoluteCalls = 0;
  const absolute = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['/etc/passwd'],
    intent: '',
    reader: {
      readPrefix() {
        absoluteCalls += 1;
        return null;
      },
    },
  });
  assert.equal(absoluteCalls, 0);
  assert.equal(absolute.missing[0].state, 'missing');
  assert.equal(absolute.uploaded, false);

  const text = formatShortlist(skills, evidence);
  assert.equal(text.includes('executed: false'), true);
  assert.equal(text.includes('uploaded: false'), true);
  assert.match(text, /^executed: false\nuploaded: false\nskills options: route, none\n/);
  assert.equal(text.includes('none'), true);
  assert.equal(text.includes('evidence missing: gone.ts state: missing'), true);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(text.endsWith('\n'), true);
  assert.equal(text.includes('behavior is absent'), false);
});

test('an unknown skill id is rejected and is not read or executed', async () => {
  const reads = [];
  let evaluateCalls = 0;
  let loadCalls = 0;
  const skills = await shortlistInstalledSkills({
    roots: ['/approved/skills'],
    intent: '',
    requestedIds: ['missing-skill'],
    reader: {
      listDirectories() {
        return ['route'];
      },
      readSkillMarkdown(_root, directoryName) {
        reads.push(directoryName);
        if (directoryName === 'missing-skill') {
          throw new Error('missing-skill must not be read');
        }
        return new TextEncoder().encode('---\nname: route\ndescription: Route advice\n---\nbody\n');
      },
    },
    evaluate() {
      evaluateCalls += 1;
    },
    load() {
      loadCalls += 1;
    },
  });

  assert.deepEqual(skills.unknownRejected, ['missing-skill']);
  assert.equal(skills.selected, 'none');
  assert.deepEqual(skills.options, ['none']);
  assert.equal(skills.executed, false);
  assert.equal(reads.includes('missing-skill'), false);
  assert.equal(evaluateCalls, 0);
  assert.equal(loadCalls, 0);
  assert.equal(JSON.stringify(skills).includes('absent'), false);
});

test('parent segments, an absolute id, and an empty id are missing and unread', async () => {
  // C34 / SKIL-02: preserve source scope. An escape is not fetched.
  // C05 / SKIL-03: the unread id stays missing. It is not absent behavior.
  const calls = [];
  const result = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['../.env', '/tmp/secret', ''],
    intent: '',
    reader: {
      readPrefix(root, relativeId) {
        calls.push([root, relativeId]);
        return { bytes: FIXTURE_BYTES, truncated: false };
      },
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.uploaded, false);
  assert.equal(result.spans.length, 0);
  assert.deepEqual(
    result.missing.map((item) => item.id),
    ['../.env', '/tmp/secret', ''],
  );
  for (const item of result.missing) assert.equal(item.state, 'missing');
  assert.equal(JSON.stringify(result).includes('absent'), false);
  assert.equal(Object.hasOwn(result, 'absent'), false);
});

test('nine explicit ids stop at eight fetches and a long prefix is hashed only to 4096', async () => {
  // C34 / SKIL-02: at most 8 spans of 4096 bytes, and the repository is not uploaded.
  const ids = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts'];
  const calls = [];
  const capped = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids,
    intent: '',
    uploaded: true,
    reader: {
      readPrefix(_root, relativeId) {
        calls.push(relativeId);
        return { bytes: FIXTURE_BYTES, truncated: false };
      },
    },
  });
  assert.equal(capped.spans.length, 8);
  assert.deepEqual(calls, ids.slice(0, 8));
  assert.equal(calls.includes('i.ts'), false);
  assert.equal(capped.truncated, true);
  assert.equal(capped.uploaded, false);
  assert.equal(capped.missing.some((item) => item.id === 'i.ts' && item.state === 'missing'), true);
  assert.equal(JSON.stringify(capped).includes('absent'), false);

  const big = new Uint8Array(5000);
  big.fill(97);
  big[4096] = 98;
  const prefix = big.subarray(0, 4096);
  const long = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['big.ts'],
    intent: '',
    reader: {
      readPrefix() {
        return { bytes: big, truncated: false };
      },
    },
  });
  assert.equal(long.spans.length, 1);
  assert.equal(long.spans[0].byteLength, 4096);
  assert.equal(long.spans[0].truncated, true);
  assert.equal(long.spans[0].sha256, sha256(prefix));
  assert.equal(long.spans[0].text, 'a'.repeat(4096));
  assert.equal(long.spans[0].text.includes('b'), false);
  assert.equal(long.uploaded, false);
});

test('a name scan stops at 64 entries and eight matches, and a miss is not absence', async () => {
  // C34 / SKIL-02: caller order, then lexical basename matches, inside a finite scan.
  // C05 / SKIL-03: an unread requested id stays missing. An unscanned name is not disproof.
  const listed = [];
  for (let i = 0; i < 64; i += 1) {
    listed.push(`m${String(i).padStart(2, '0')}/route.ts`);
  }
  const sixtyFifth = 'aaa/route.ts';
  listed.push(sixtyFifth);
  const longName = `${'p'.repeat(250)}/route.ts`;
  assert.ok(new TextEncoder().encode(longName).byteLength > 256);
  listed[0] = longName;
  listed[1] = 'router.ts';
  listed[2] = 'route.ts';

  const calls = [];
  const scanned = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['explicit.ts'],
    intent: 'route',
    reader: {
      listFiles() {
        return listed;
      },
      readPrefix(_root, relativeId) {
        calls.push(relativeId);
        return { bytes: FIXTURE_BYTES, truncated: false };
      },
    },
  });
  assert.equal(calls.includes(sixtyFifth), false);
  assert.equal(calls.includes(longName), false);
  assert.equal(calls[0], 'explicit.ts');
  assert.ok(calls.length <= 8);
  assert.equal(scanned.spans.length <= 8, true);
  assert.equal(scanned.truncated, true);
  assert.equal(scanned.uploaded, false);
  assert.equal(scanned.missing.some((item) => item.id === sixtyFifth), false);
  assert.equal(JSON.stringify(scanned).includes('absent'), false);

  const rankCalls = [];
  const ranked = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: [],
    intent: 'route',
    reader: {
      listFiles() {
        return ['router.ts', 'src/route.ts', 'notes/route', 'route.ts'];
      },
      readPrefix(_root, relativeId) {
        rankCalls.push(relativeId);
        return { bytes: FIXTURE_BYTES, truncated: false };
      },
    },
  });
  assert.equal(rankCalls.includes('router.ts'), false);
  assert.deepEqual(rankCalls, ['notes/route', 'route.ts', 'src/route.ts']);
  assert.equal(ranked.missing.some((item) => item.id === 'router.ts'), false);
  assert.equal(ranked.uploaded, false);
  assert.equal(ranked.truncated, false);

  const miss = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['gone.ts'],
    intent: 'route',
    reader: {
      readPrefix() {
        return null;
      },
    },
  });
  assert.equal(miss.missing[0].state, 'missing');
  assert.equal(Object.hasOwn(miss, 'absent'), false);
  assert.equal(Object.hasOwn(miss, 'behaviorAbsent'), false);
  assert.equal(Object.hasOwn(miss, 'provedAbsent'), false);
  assert.equal(JSON.stringify(miss).includes('absent'), false);
  assert.equal(JSON.stringify(miss).includes('sha256'), false);
});

test('a missing id is printed as missing and is not an absence proof', async () => {
  // C05 / SKIL-03: unavailable evidence is not marked absent behavior.
  const skills = await shortlistInstalledSkills({
    roots: [],
    intent: '',
    requestedIds: [],
    reader: {
      listDirectories() {
        return [];
      },
      readSkillMarkdown() {
        return null;
      },
    },
  });
  const evidence = await shortlistEvidence({
    roots: ['/approved/repo'],
    ids: ['gone.ts'],
    intent: '',
    reader: {
      readPrefix() {
        return null;
      },
    },
  });
  const text = formatShortlist(skills, evidence);
  assert.equal(text.includes('evidence missing: gone.ts state: missing'), true);
  assert.equal(text.includes('executed: false'), true);
  assert.equal(text.includes('uploaded: false'), true);
  assert.equal(text.includes('absent'), false);
  assert.equal(text.includes('\u001b'), false);
  assert.equal(text.includes('behavior is absent'), false);

  const colored = formatShortlist(skills, {
    schemaVersion: '1.0',
    uploaded: false,
    spans: [],
    missing: [{ id: 'gone\u001b.ts', state: 'missing' }],
    truncated: false,
  });
  assert.equal(colored.includes('\u001b'), false);
  assert.equal(colored.includes('evidence missing: gone.ts state: missing'), true);
  assert.equal(colored.includes('absent'), false);
});

test('a dangerous key returns executed false and does not call the reader', async () => {
  let calls = 0;
  const input = {
    roots: ['/approved/skills'],
    intent: 'use route',
    requestedIds: ['missing-skill'],
    reader: {
      listDirectories() {
        calls += 1;
        return ['route'];
      },
      readSkillMarkdown() {
        calls += 1;
        return null;
      },
    },
  };
  Object.defineProperty(input, '__proto__', { value: { admin: true }, enumerable: true });
  const skills = await shortlistInstalledSkills(input);
  assert.equal(skills.executed, false);
  assert.deepEqual(skills.options, ['none']);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(skills).includes('admin'), false);

  const prototype = await shortlistInstalledSkills(Object.create(null));
  assert.equal(prototype.executed, false);
  const constructed = { roots: [], intent: '', requestedIds: [], reader: {} };
  Object.defineProperty(constructed, 'constructor', { value: () => calls += 1, enumerable: true });
  const rejected = await shortlistInstalledSkills(constructed);
  assert.equal(rejected.executed, false);
  assert.equal(calls, 0);
});

function skillMarkdown(name, description) {
  return new TextEncoder().encode(
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

test('a directory named none is not the abstention option and is not read', async () => {
  // C33: suggest applicable skills plus none. Do not execute skill code from a ranking.
  // R07: no unknown skill is executed. A reserved directory is not that option.
  const reads = [];
  const skills = await shortlistInstalledSkills({
    roots: ['/approved/skills'],
    intent: 'use route',
    requestedIds: [],
    reader: {
      listDirectories() {
        return ['none', 'route'];
      },
      readSkillMarkdown(_root, directoryName) {
        reads.push(directoryName);
        if (directoryName === 'none' || directoryName === 'unknown') {
          throw new Error('reserved directory must not be read');
        }
        return skillMarkdown('route', 'Route advice');
      },
    },
  });
  assert.deepEqual(reads, ['route']);
  assert.deepEqual(skills.options, ['route', 'none']);
  assert.equal(skills.selected, 'route');
  assert.equal(skills.executed, false);
  assert.equal(skills.inventory.some((entry) => entry.id === 'none'), false);
  assert.equal(skills.options[skills.options.length - 1], 'none');
});

test('a directory named unknown is not read and is not the none option', async () => {
  // C33 / R07: unknown is reserved. The emitted none has no directory.
  let reads = 0;
  const skills = await shortlistInstalledSkills({
    roots: ['/approved/skills'],
    intent: 'use unknown',
    requestedIds: ['unknown'],
    reader: {
      listDirectories() {
        return ['unknown'];
      },
      readSkillMarkdown() {
        reads += 1;
        throw new Error('unknown must not be read');
      },
    },
  });
  assert.equal(reads, 0);
  assert.deepEqual(skills.options, ['none']);
  assert.equal(skills.selected, 'none');
  assert.equal(skills.executed, false);
  assert.equal(skills.inventory.length, 0);
  assert.equal(skills.unknownRejected.includes('unknown'), true);
});

test('a frontmatter name is not a path and a sibling is not read', async () => {
  // C33: do not load or execute arbitrary skill code based on a ranking.
  // R07: no unknown skill is executed. The body is not a command.
  const reads = [];
  let loadCalls = 0;
  let siblingCalls = 0;
  const shellLine = '!`pwd`';
  const canary = 'CANARY_NOT_DESCRIPTION';
  const skills = await shortlistInstalledSkills({
    roots: ['/approved/skills'],
    intent: 'use route',
    requestedIds: [],
    reader: {
      listDirectories() {
        return ['route'];
      },
      readSkillMarkdown(root, directoryName) {
        reads.push([root, directoryName]);
        if (directoryName !== 'route') {
          throw new Error('frontmatter name must not be opened');
        }
        if (String(directoryName).includes('/') || String(directoryName).includes('scripts')) {
          throw new Error('sibling must not be requested');
        }
        const text = [
          '---',
          'name: ../../other',
          'allowed-tools: Bash',
          'toolPermission: allow',
          'description: Route advice',
          '---',
          shellLine,
          canary,
          'description: BODY_DESCRIPTION',
        ].join('\n');
        return new TextEncoder().encode(text);
      },
      readSibling() {
        siblingCalls += 1;
        throw new Error('sibling must not be requested');
      },
    },
    load() {
      loadCalls += 1;
    },
  });
  assert.deepEqual(reads, [['/approved/skills', 'route']]);
  assert.equal(skills.inventory[0].id, 'route');
  assert.equal(skills.inventory[0].description, 'Route advice');
  assert.equal(skills.executed, false);
  assert.equal(loadCalls, 0);
  assert.equal(siblingCalls, 0);
  const encoded = JSON.stringify(skills);
  assert.equal(encoded.includes('toolPermission'), false);
  assert.equal(encoded.includes('../../other'), false);
  assert.equal(encoded.includes(canary), false);
  assert.equal(encoded.includes(shellLine), false);
  assert.equal(encoded.includes('BODY_DESCRIPTION'), false);
  assert.equal(Object.hasOwn(skills, 'toolPermission'), false);
  assert.equal(Object.hasOwn(skills, 'permission'), false);
  assert.equal(skills.options[skills.options.length - 1], 'none');
});

test('sixty-five pattern-valid directories stop at sixty-four reads', async () => {
  // C33 / R07: ranking does not read past the inventory cap, and options still end with none.
  const names = [];
  for (let i = 64; i >= 0; i -= 1) names.push(`skill-${String(i).padStart(2, '0')}`);
  const reads = [];
  const skills = await shortlistInstalledSkills({
    roots: ['/approved/skills'],
    intent: 'use skill-64',
    requestedIds: [],
    reader: {
      listDirectories() {
        return names;
      },
      readSkillMarkdown(_root, directoryName) {
        reads.push(directoryName);
        return skillMarkdown(directoryName, 'Advice');
      },
    },
  });
  assert.equal(reads.length, 64);
  assert.equal(reads.includes('skill-64'), false);
  assert.equal(reads.includes('skill-00'), true);
  assert.equal(skills.truncated, true);
  assert.equal(skills.executed, false);
  assert.equal(skills.selected, 'none');
  assert.equal(skills.options[skills.options.length - 1], 'none');
  assert.equal(skills.inventory.some((entry) => entry.id === 'skill-64'), false);
  assert.equal(skills.inventory.length, 64);
});
