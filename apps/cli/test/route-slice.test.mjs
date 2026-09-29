// CMD-03, TOOL-02, RTE-04: `jevris route --slice <id>` and jevris_plan_route's `sliceId` name the
// task slice, so the sidecar can check a released calibration for managed-worker advice. The id
// is validated like every other id; the CLI and MCP send the same field.
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseOpInput } = await import('../dist/public/inputs.js');
const { TOOLS } = await import('../../../packages/mcp/dist/main.js');

test('route takes a slice id and refuses a malformed one', () => {
  const ok = parseOpInput('route', { currentModel: 'claude-opus-5', sliceId: 'bounded-edit' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.input.sliceId, 'bounded-edit');
  assert.equal(parseOpInput('route', {}).input.sliceId, null, 'no slice is null');
  assert.equal(parseOpInput('route', { sliceId: '../etc' }).ok, false);
  assert.equal(parseOpInput('route', { slice: 'bounded-edit' }).ok, false, 'an unknown key is refused');
});

test('the MCP route tool offers sliceId', () => {
  const route = TOOLS.find((tool) => tool.name === 'jevris_plan_route');
  assert.equal(route.inputSchema.properties.sliceId?.type, 'string');
});
