// KIL-01 and OPC-01: the one committed plugin template (plugins/shared/shim.js) is exactly what
// the generator makes from the built adapters, renders each harness's plugin, a null runtime
// line registers no hooks, and a substituted runtime forwards native events to the launcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { emitShims, renderShim, RUNTIME_LINE, SHIMS, shimTarget, substituteRuntime, TEMPLATE_OUT } from '../scripts/emit-shim.mjs';
import { renderShimPlugin, SHIM_EXPORTS, SHIM_PLACEHOLDERS } from '../dist/index.js';

const root = join(import.meta.dirname, '..', '..', '..');
const template = readFileSync(join(root, ...TEMPLATE_OUT), 'utf8');
// Each harness's values come from its own manifest, plugins/<harness>/harness.json.
const plugin = (spec) => renderShimPlugin(template, shimTarget(spec, root));

test('the committed template matches the generator and renders each harness plugin (drift check)', async () => {
  assert.deepEqual(await emitShims({ root, check: true }), []);
  for (const line of Object.values(SHIM_PLACEHOLDERS)) assert.equal(template.split('\n').filter((item) => item === line).length, 1, line);
  for (const spec of SHIMS) {
    const text = plugin(spec);
    assert.equal(text, renderShim(spec, SHIM_EXPORTS[shimTarget(spec, root).exportForm], root), `${spec.harness}: the template renders the adapter's own plugin`);
    assert.equal(text.includes('@JEVRIS_'), false);
    assert.equal(text.split('\n').filter((line) => line === RUNTIME_LINE).length, 1, spec.harness);
    assert.equal(/^\s*import\s/m.test(text), false, `${spec.harness} imports nothing`);
    assert.equal(/permissionDecision|'permission\.ask'/.test(text), false, `${spec.harness} registers no permission hook`);
  }
});

async function load(spec, text) {
  const dir = mkdtempSync(join(tmpdir(), `jevris-shim-${spec.harness}-`));
  const file = join(dir, 'jevris.mjs');
  writeFileSync(file, text);
  const mod = await import(pathToFileURL(file).href);
  const server = spec.harness === 'kilocode' ? mod.default.server : mod.JevrisPlugin;
  if (spec.harness === 'kilocode') assert.equal(mod.default.id, 'jevris');
  else assert.deepEqual(Object.keys(mod), ['JevrisPlugin']);
  return { dir, server };
}

test('a null runtime line gives an inert plugin with no hooks', async () => {
  for (const spec of SHIMS) {
    const { dir, server } = await load(spec, plugin(spec));
    try {
      assert.deepEqual(await server({}), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a substituted runtime forwards events to the launcher and adds compaction context', async () => {
  for (const spec of SHIMS) {
    const work = mkdtempSync(join(tmpdir(), `jevris-shim-launch-${spec.harness}-`));
    const launcher = join(work, 'launcher.mjs');
    const seen = join(work, 'seen.jsonl');
    writeFileSync(
      launcher,
      [
        "import { appendFileSync } from 'node:fs';",
        "let data = '';",
        "process.stdin.on('data', (c) => { data += c; });",
        "process.stdin.on('end', () => {",
        `  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), native: JSON.parse(data) }) + '\\n');`,
        "  process.stdout.write(JSON.stringify({ context: ['capsule from launcher'] }));",
        '});',
      ].join('\n'),
    );
    const text = substituteRuntime(plugin(spec), { node: process.execPath, launcher });
    assert.notEqual(text, null);
    const { dir, server } = await load(spec, text);
    try {
      const hooks = await server({});
      assert.deepEqual(Object.keys(hooks).sort(), ['chat.message', 'command.execute.before', 'event', 'experimental.chat.system.transform', 'experimental.session.compacting', 'tool.execute.after', 'tool.execute.before']);
      const output = { context: [] };
      await hooks['experimental.session.compacting']({ sessionID: 'ses_1' }, output);
      assert.deepEqual(output.context, ['capsule from launcher']);
      // FIX-14: no other hook writes to its output, whatever the launcher prints.
      const toolOutput = { args: { command: 'ls' } };
      await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1', callID: 'c1' }, toolOutput);
      const chatOutput = { message: { id: 'm' }, parts: [] };
      await hooks['chat.message']({ sessionID: 'ses_1' }, chatOutput);
      assert.deepEqual(toolOutput, { args: { command: 'ls' } });
      assert.deepEqual(chatOutput, { message: { id: 'm' }, parts: [] });
      // G4: a launcher answer with no system text shows nothing on the turn.
      const systemOutput = { system: ['vendor'] };
      await hooks['experimental.chat.system.transform']({ sessionID: 'ses_1', model: {} }, systemOutput);
      assert.deepEqual(systemOutput, { system: ['vendor'] });
      const lines = readFileSync(seen, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const launcherName = spec.harness === 'kilocode' ? 'kilo' : 'opencode';
      assert.deepEqual(lines[0].argv, ['--harness', launcherName]);
      assert.equal(lines[0].native.hookKey, 'experimental.session.compacting');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  }
});

test('substitution refuses a shim without exactly one runtime line', () => {
  assert.equal(substituteRuntime('const x = 1;\n', { node: 'node', launcher: '/l' }), null);
  assert.equal(substituteRuntime(`${RUNTIME_LINE}\n${RUNTIME_LINE}\n`, { node: 'node', launcher: '/l' }), null);
  const out = substituteRuntime(`a\n${RUNTIME_LINE}\nb`, { node: 'node', launcher: 'C:\\Users\\A B\\hook.mjs' });
  assert.equal(out, 'a\nconst JEVRIS_RUNTIME = {"node":"node","launcher":"C:\\\\Users\\\\A B\\\\hook.mjs"};\nb');
});

test('the template renderer refuses a template without exactly one of each placeholder, or an unknown harness', () => {
  const kilo = { harness: 'kilocode', launcher: 'kilo', exportForm: 'default' };
  assert.equal(renderShimPlugin(template.replace(SHIM_PLACEHOLDERS.exports, ''), kilo), null);
  assert.equal(renderShimPlugin(`${template}\n${SHIM_PLACEHOLDERS.harness}`, { ...kilo, harness: 'opencode' }), null);
  assert.equal(renderShimPlugin(template, { ...kilo, harness: 'codex' }), null);
  assert.equal(renderShimPlugin(template, { ...kilo, launcher: "kilo'; x" }), null);
  assert.equal(renderShimPlugin(template, { ...kilo, exportForm: 'toString' }), null);
  assert.equal(renderShimPlugin(`${template}\n// @JEVRIS_OTHER@`, kilo), null);
});
