import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, story } from './lib.mjs';

// Other tools' files as a developer already has them. Byte-exact text, so any rewrite shows.
const USER_FILES = {
  'home/.claude/settings.json': '{\n  "theme": "dark",\n  "enabledPlugins": { "other@market": true },\n  "hooks": {\n    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo mine" }] }]\n  }\n}\n',
  'home/.claude/settings.local.json': '{"permissions":{"allow":["Bash(ls)"]}}\n',
  'home/.claude/plugins/other/plugin.json': '{"name":"other"}\n',
  'home/.codex/config.toml': '# mine\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "other"\n',
  'home/.config/opencode/opencode.json': '{\n  "$schema": "https://opencode.ai/config.json",\n  "theme": "x"\n}\n',
  'home/.config/kilo/kilo.json': '{\n  "model": "anthropic/claude"\n}\n',
};

/** A parsed config with every Jevris key and array entry removed. */
function withoutJevris(value) {
  if (Array.isArray(value)) return value.filter((item) => !JSON.stringify(item).includes('jevris')).map(withoutJevris);
  if (value === null || typeof value !== 'object') return value;
  // An object that only held Jevris entries (for example extraKnownMarketplaces) goes with them.
  const emptied = (item, original) => item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0 && Object.keys(original).length > 0;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/jevris/i.test(key))
      .map(([key, item]) => [key, withoutJevris(item), item])
      .filter(([, item, original]) => !emptied(item, original))
      .map(([key, item]) => [key, item]),
  );
}

/** True when every line of `before` still appears in `after`, in order. */
function keepsLines(before, after) {
  const lines = after.split('\n');
  let at = 0;
  for (const line of before.split('\n')) {
    const found = lines.indexOf(line, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

story('US01', async ({ then, sandbox, evidence }) => {
  const box = await sandbox();
  for (const [rel, text] of Object.entries(USER_FILES)) box.write(rel, text);
  const { jevrisPaths } = await load('platform');
  const data = jevrisPaths({ home: box.home }).data;

  const install = box.jevris(['install', '--yes', '--home', box.home], { json: true });
  assert.equal(install.code, 0, `install failed: ${install.stderr}`);
  assert.equal(install.json?.ok, true, `install failed: ${install.json?.error}`);
  evidence(install.json);
  const created = install.json.changes.filter((change) => change.action === 'create').map((change) => change.path);
  const edited = install.json.changes.filter((change) => change.action === 'edit').map((change) => change.path);

  // The developer changes their own settings while Jevris is installed, and edits one file
  // Jevris added (a skill page), before uninstalling.
  const settings = 'home/.claude/settings.json';
  const userEdit = box.read(settings).replace('"theme": "dark",', '"theme": "dark",\n  "model": "opus",');
  box.write(settings, userEdit);
  const touched = created.find((path) => path.endsWith('SKILL.md'));
  assert.notEqual(touched, undefined, 'install created no skill page');
  box.write(join('home', touched), `${box.read(join('home', touched))}\nmy own note\n`);
  // The developer also appends their own table at the end of the Codex config, after the
  // entries Jevris added there.
  const codex = 'home/.codex/config.toml';
  const codexTail = '\n# added while Jevris was installed\n[profiles.mine]\nmodel = "o4-mini"\n';
  const codexInstalled = box.read(codex);
  assert.equal(codexInstalled.includes('jevris'), true, 'install did not register Jevris in the Codex config');
  box.write(codex, `${codexInstalled}${codexTail}`);
  const userEdited = new Set([settings, codex]);

  const uninstall = box.jevris(['uninstall', '--home', box.home], { json: true });
  assert.equal(uninstall.code, 0, `uninstall failed: ${uninstall.stderr}`);
  evidence(uninstall.json);

  await then('Only Jevris-owned entries change', () => {
    assert.equal(created.length > 0, true, 'install created nothing');
    for (const path of created) assert.match(path, /jevris/i, `install created ${path}, which is not a Jevris path`);
    for (const path of edited) {
      const rel = `home/${path}`;
      const before = USER_FILES[rel];
      if (before === undefined) continue; // a file Jevris created as a shared config (for example a marketplace list)
      const after = rel === settings ? null : box.read(rel);
      if (after !== null && rel.endsWith('.json')) assert.deepEqual(withoutJevris(JSON.parse(after)), withoutJevris(JSON.parse(before)), `${path}: a non-Jevris entry changed`);
      if (after !== null && rel.endsWith('.toml')) assert.equal(keepsLines(before, after), true, `${path}: a line the user wrote changed`);
    }
    for (const rel of ['home/.claude/settings.local.json', 'home/.claude/plugins/other/plugin.json']) assert.equal(box.read(rel), USER_FILES[rel], `${rel} changed`);
    // After uninstall every file the user did not touch is back byte for byte.
    for (const [rel, text] of Object.entries(USER_FILES)) if (!userEdited.has(rel)) assert.equal(box.read(rel), text, `${rel} is not restored byte for byte`);
    for (const path of created) if (path !== touched) assert.equal(existsSync(join(box.home, path)), false, `${path} was left behind`);
  });

  await then('a concurrent user edit is preserved and data deletion is a separate choice', async () => {
    const after = readFileSync(join(box.dir, settings), 'utf8');
    assert.deepEqual(JSON.parse(after), withoutJevris(JSON.parse(userEdit)), 'the settings the user changed after install were not kept');
    assert.equal(JSON.parse(after).model, 'opus');
    assert.equal(after.includes('jevris'), false, 'a Jevris entry stayed in settings.json');
    assert.equal(box.read(join('home', touched)).endsWith('my own note\n'), true, 'the Jevris file the user edited was removed');
    // The table the user appended at the end of the Codex config survives; only Jevris's entries go.
    const codexAfter = box.read(codex);
    assert.equal(codexAfter.includes('jevris'), false, `a Jevris entry stayed in config.toml:\n${codexAfter}`);
    assert.equal(keepsLines(USER_FILES[codex], codexAfter), true, 'a line the user wrote before install changed');
    assert.equal(codexAfter.trimEnd().endsWith('[profiles.mine]\nmodel = "o4-mini"'), true, `the user's end-of-file table was dropped:\n${codexAfter}`);
    assert.equal(codexAfter.includes('# added while Jevris was installed'), true);
    assert.deepEqual(uninstall.json.conflicts, [touched], 'the edited Jevris file was not reported');
    // Plain uninstall keeps the data folder; deleting it is its own, explicit choice.
    assert.equal(uninstall.json.changes.some((change) => change.detail === 'Jevris data'), false);
    assert.equal(existsSync(data), true, 'uninstall without --delete-data removed the data folder');
    const purge = box.jevris(['uninstall', '--delete-data', '--home', box.home], { json: true });
    assert.equal(purge.code, 0, `uninstall --delete-data failed: ${purge.stderr}`);
    evidence(purge.json);
    assert.equal(existsSync(data), false, '--delete-data left the data folder');
    for (const [rel, text] of Object.entries(USER_FILES)) if (!userEdited.has(rel)) assert.equal(box.read(rel), text, `--delete-data changed ${rel}`);
    assert.equal(box.read(settings), after, '--delete-data changed settings.json');
    assert.equal(box.read(codex), codexAfter, '--delete-data changed config.toml');
  });
});
