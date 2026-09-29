import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTOCOL_CANDIDATES = ['2024-11-05', '2025-03-26', '2025-06-18', '2026-07-28'];
const DEFAULT_PROTOCOL = '2025-03-26';
const ABSTAIN =
  'Rules-only abstention: sidecar is not running. No check was marked passed.';
const BYTE_CAP = 131072;
const CLI_MS = 15000;
const HARNESSES = new Set(['claude', 'kilocode', 'codex', 'opencode', 'antigravity']);

const TOOLS = [
  ['jevris_install', 'Platform install. Copies a harness plugin. Does not certify an actuator.'],
  ['jevris_uninstall', 'Platform uninstall. Removes a harness copy.'],
  ['jevris_data_delete', 'Platform data delete. Removes .jevris under home. Does not grant a tool.'],
  ['jevris_doctor', 'Platform doctor. Reads support facts. Does not certify an actuator.'],
  ['jevris_shortlist', 'Platform shortlist. Names local skills. Does not execute skill code.'],
  ['jevris_shadow', 'Platform shadow. Compares labels. applied stays false.'],
  ['jevris_credential', 'Platform credential status. Does not print a secret. set and clear are refused.'],
  ['jevris_policy', 'Platform policy. This process does not send source and does not waive a lock.'],
  ['jevris_gates', 'Platform gates. Reads recorded verdicts. Does not mark a gate passed.'],
  ['jevris_kill_switch', 'Platform kill-switch activate. Does not grant a tool.'],
  ['jevris_status', 'Platform status. Does not mark a check passed.'],
  ['jevris_plan', 'Platform plan. Does not schedule work.'],
  ['jevris_route', 'Platform route. Does not switch a model.'],
  ['jevris_checkpoint', 'Platform checkpoint. Does not compact and does not replace a summary.'],
  ['jevris_recover', 'Platform recover. Does not restore from an untrusted capsule.'],
  ['jevris_verify', 'Platform verify. Verification stays unsupported.'],
  ['jevris_explain', 'Platform explain. Does not treat a model summary as evidence.'],
  ['jevris_configure', 'Platform configure. Does not change native permissions.'],
];

const PUBLIC = {
  jevris_status: 'status',
  jevris_plan: 'plan',
  jevris_route: 'route',
  jevris_checkpoint: 'checkpoint',
  jevris_recover: 'recover',
  jevris_verify: 'verify',
  jevris_explain: 'explain',
  jevris_configure: 'configure',
};

function toolSpec(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        home: { type: 'string' },
        harness: { type: 'string', enum: ['claude', 'kilocode', 'codex', 'opencode', 'antigravity'] },
        enable: { type: 'boolean' },
        action: { type: 'string', enum: ['status', 'set', 'clear'] },
        intent: { type: 'string' },
        fixture: { type: 'string' },
        root: { type: 'string' },
        out: { type: 'string' },
        workspace: { type: 'string' },
        ledger: { type: 'string' },
        workspaceId: { type: 'string' },
        hostScope: { type: 'string' },
      },
    },
  };
}

function textResult(name, text) {
  return {
    content: [{ type: 'text', text }],
    isError: false,
    structuredContent: {
      command: name,
      authorityGranted: false,
      toolPermission: false,
      passed: false,
      applied: false,
      certified: false,
      credentialRef: 'host-secret:typesafe-primary',
      presence: 'missing',
    },
  };
}

function plain(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0');
}

function homeOf(args) {
  return args && plain(args.home) ? args.home : null;
}

function harnessOf(args) {
  if (!args || args.harness === undefined) return { ok: true };
  if (args.harness === 'gemini' || !HARNESSES.has(args.harness)) return { ok: false };
  return { ok: true, value: args.harness };
}

function cliInvocation() {
  const fromEnv = process.env.JEVRIS_BIN;
  if (plain(fromEnv)) return { command: process.execPath, prefix: [fromEnv] };
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pointer = JSON.parse(readFileSync(join(here, 'jevris-bin.json'), 'utf8'));
    if (pointer && plain(pointer.bin)) return { command: process.execPath, prefix: [pointer.bin] };
  } catch {
    // No install pointer.
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'bin', 'jevris.mjs');
    try {
      readFileSync(candidate);
      return { command: process.execPath, prefix: [candidate] };
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { command: 'jevris', prefix: [] };
}

function runPlatform(argv) {
  const launch = cliInvocation();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const child = spawn(launch.command, [...launch.prefix, ...argv], {
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, CLI_MS);
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > BYTE_CAP) {
        child.kill();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function argvFor(name, args) {
  if (name === 'jevris_policy') return { error: 'Policy check is not run from this process. No source was sent.' };
  if (name === 'jevris_credential') {
    const action = args && args.action;
    if (action === 'set' || action === 'clear') {
      return { error: 'Credential write refused. No secret was read.' };
    }
    return { argv: ['credential', 'status'] };
  }
  const home = homeOf(args);
  const harness = harnessOf(args);
  if (!harness.ok) return { error: 'refused' };
  if (name === 'jevris_gates') {
    if (!plain(args && args.root) || !plain(args && args.out)) return { error: 'refused' };
    return { argv: ['gates', '--root', args.root, '--out', args.out] };
  }
  if (name === 'jevris_kill_switch') {
    if (
      home === null ||
      !plain(args.workspace) ||
      !plain(args.ledger) ||
      !plain(args.workspaceId) ||
      !plain(args.hostScope)
    ) {
      return { error: 'refused' };
    }
    return {
      argv: [
        'kill-switch',
        'activate',
        '--home',
        home,
        '--workspace',
        args.workspace,
        '--ledger',
        args.ledger,
        '--workspace-id',
        args.workspaceId,
        '--host-scope',
        args.hostScope,
      ],
    };
  }
  if (home === null) return { error: 'refused' };
  if (name === 'jevris_install') {
    const argv = ['install', '--home', home];
    if (harness.value !== undefined) argv.push('--harness', harness.value);
    if (args.enable === true) argv.push('--enable');
    return { argv };
  }
  if (name === 'jevris_uninstall') {
    const argv = ['uninstall', '--home', home];
    if (harness.value !== undefined) argv.push('--harness', harness.value);
    return { argv };
  }
  if (name === 'jevris_data_delete') return { argv: ['data', 'delete', '--home', home] };
  if (name === 'jevris_doctor') return { argv: ['doctor', '--home', home] };
  if (name === 'jevris_shortlist') {
    const argv = ['shortlist', '--home', home];
    if (plain(args.intent)) argv.push('--intent', args.intent);
    return { argv };
  }
  if (name === 'jevris_shadow') {
    if (!plain(args.fixture)) return { error: 'refused' };
    return { argv: ['shadow', '--home', home, '--fixture', args.fixture] };
  }
  const command = PUBLIC[name];
  if (command === undefined) return { error: 'unknown tool' };
  return { argv: [command, '--home', home] };
}

export function toolNames() {
  return TOOLS.map((entry) => entry[0]);
}

export async function callTool(name, args) {
  if (!toolNames().includes(name)) {
    return { error: { code: -32602, message: 'unknown tool' } };
  }
  const built = argvFor(name, args && typeof args === 'object' ? args : {});
  if (built.error !== undefined) return { result: textResult(name, built.error) };
  const text = await runPlatform(built.argv);
  if (text === null || text.length === 0) return { result: textResult(name, ABSTAIN) };
  return { result: textResult(name, text) };
}

export async function handleMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const method = message.method;
  const id = message.id;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'invalid request' } };
  }
  if (method === 'initialize') {
    const requested = message.params && message.params.protocolVersion;
    const protocolVersion = PROTOCOL_CANDIDATES.includes(requested) ? requested : DEFAULT_PROTOCOL;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jevris', version: '0.1.0' },
        instructions:
          'Jevris platform interface. Tools run the local jevris entry. They do not grant a permission and do not certify an actuator.',
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS.map((entry) => toolSpec(entry[0], entry[1])) } };
  }
  if (method === 'tools/call') {
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    const name = params.name;
    const called = await callTool(typeof name === 'string' ? name : '', params.arguments);
    if (called.error !== undefined) return { jsonrpc: '2.0', id, error: called.error };
    return { jsonrpc: '2.0', id, result: called.result };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: 'method not found' } };
}

function isEntry() {
  const entry = process.argv[1];
  if (typeof entry !== 'string') return false;
  return entry.endsWith('mcp.js');
}

if (isEntry()) {
  let pending = Buffer.alloc(0);
  process.stdin.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.byteLength > BYTE_CAP) {
      process.exit(0);
    }
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      const line = pending.subarray(0, newline).toString('utf8').trim();
      pending = pending.subarray(newline + 1);
      if (line.length > 0) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = undefined;
        }
        if (parsed !== undefined) {
          void handleMessage(parsed).then((response) => {
            if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
          });
        }
      }
      newline = pending.indexOf(0x0a);
    }
  });
}
