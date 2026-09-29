/**
 * DATA-12: `jevris data delete` scopes (SSOT §16.3, US01).
 *
 * Without --scope, the whole Jevris data folder goes (as before): the ledger, capsules, receipts,
 * runtime copy and backups, and the kill switch files. --scope narrows it to ledger, capsules,
 * learning, config or credential, or widens it to all (the data folder, the config folder and the host
 * credential). The ledger is the store and every jevris.db* file beside it, and the decision
 * journal. `learning` is C's route-learning aggregates (`<data>/route-learning`), their own
 * retention class outside the age sweep (B's ROUTE_LEARNING_RETENTION), and the learning records in
 * the store (B's purgeStoreLearning). --dry-run lists what would go and changes nothing. Every answer says that local
 * deletion is not deletion by a model vendor or gateway.
 *
 * Only the CLI can delete: no MCP tool or surface operation reaches this code.
 */
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { jevrisPaths } from '@jevris/platform';
import { COMMAND_EXIT_CODES, HOST_SECRET_ACCOUNT, HOST_SECRET_SERVICE } from '@jevris/contracts';
import { ROUTE_LEARNING_RETENTION } from '@jevris/store';
import type { OpenHostSecret } from './credential.js';
import type { ServiceExec } from './global-harness.js';

export const DATA_SCOPES = ['ledger', 'capsules', 'learning', 'config', 'credential'] as const;
export type DataScope = (typeof DATA_SCOPES)[number];

/** `data` is the whole data folder (the default); `all` adds config and the credential. */
export type DataSelection = { readonly whole: boolean; readonly scopes: readonly DataScope[] };

export const VENDOR_NOTICE =
  'Local deletion removes Jevris data on this machine only. It does not delete anything a model vendor or gateway already received; ask them under their own terms.';

/**
 * The ledger's files in the data folder (B, DATA-12): the store, its -wal and -shm, its
 * .authz-key and .writer lock, and the jevris.db.pre-v<N>-* migration backups beside it. Backups
 * a person made with `store backup` live where they chose and are left alone.
 */
async function ledgerFiles(data: string): Promise<readonly string[]> {
  let names: readonly string[] = [];
  try {
    names = await readdir(data);
  } catch {
    names = [];
  }
  return ['jevris.db', ...names.filter((name) => name.startsWith('jevris.db') && name !== 'jevris.db').sort()];
}

/**
 * Capsules live as files and as capsule_index rows in the store. B's purgeStoreCapsules removes
 * the rows (pinned ones too) and audits it; with no store there are no rows to remove.
 */
async function purgeCapsuleRows(home: string): Promise<boolean> {
  if (!(await present(join(jevrisPaths({ home }).data, 'jevris.db')))) return true;
  const { purgeStoreCapsules } = await import('./runtime-commands.js');
  return (await purgeStoreCapsules(home)).ok;
}

/**
 * The learning scope's store half (owner 2026-09-27): B's purgeStoreLearning removes the learning
 * records in the store (decision outcomes, session model changes, advice adherence, latency
 * counters) and audits it; with no store there are no rows to remove.
 */
async function purgeLearningRows(home: string): Promise<boolean> {
  if (!(await present(join(jevrisPaths({ home }).data, 'jevris.db')))) return true;
  const { purgeStoreLearning } = await import('./runtime-commands.js');
  return (await purgeStoreLearning(home)).ok;
}

/** Parses --scope: a comma list of ledger, capsules, learning, config, credential, data or all. */
export function parseScopes(value: string | boolean | undefined): DataSelection | null {
  if (value === undefined) return { whole: true, scopes: [] };
  if (typeof value !== 'string' || value.length === 0) return null;
  let whole = false;
  const scopes = new Set<DataScope>();
  for (const part of value.split(',').map((item) => item.trim())) {
    if (part === 'data') whole = true;
    else if (part === 'all') {
      whole = true;
      scopes.add('config');
      scopes.add('credential');
    } else if ((DATA_SCOPES as readonly string[]).includes(part)) scopes.add(part as DataScope);
    else return null;
  }
  // The whole data folder already holds the ledger, the capsules and the learning state.
  if (whole) {
    scopes.delete('ledger');
    scopes.delete('capsules');
    scopes.delete('learning');
  }
  return { whole, scopes: DATA_SCOPES.filter((item) => scopes.has(item)) };
}

export interface PlannedDeletion {
  readonly scope: 'data' | DataScope;
  /** A file or folder, or the keychain entry for the credential. */
  readonly target: string;
  readonly present: boolean;
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The files and folders one selection covers, in deletion order. */
export async function planDeletion(
  home: string,
  selection: DataSelection,
  options: { readonly credentialLabel: string; readonly credentialPresent: boolean | null },
): Promise<readonly PlannedDeletion[]> {
  const paths = jevrisPaths({ home });
  const items: PlannedDeletion[] = [];
  const add = async (scope: PlannedDeletion['scope'], target: string): Promise<void> => {
    if (!items.some((item) => item.target === target)) items.push({ scope, target, present: await present(target) });
  };
  if (selection.whole) {
    await add('data', paths.data);
    if (!inside(paths.data, paths.state)) await add('data', paths.state);
    if (paths.legacyData !== paths.data && !inside(paths.data, paths.legacyData)) await add('data', paths.legacyData);
  }
  if (selection.scopes.includes('ledger')) {
    // The store, its WAL files, its authorization key and writer lock, and the decision journal.
    // There is no registry of ledgers elsewhere (B, DATA-12), so only these default paths go.
    for (const name of await ledgerFiles(paths.data)) await add('ledger', join(paths.data, name));
    await add('ledger', join(paths.data, 'decisions'));
  }
  if (selection.scopes.includes('capsules')) await add('capsules', join(paths.data, 'capsules'));
  if (selection.scopes.includes('learning')) await add('learning', join(paths.data, ROUTE_LEARNING_RETENTION.directory));
  if (selection.scopes.includes('config')) {
    await add('config', paths.config);
    if (paths.legacyConfig !== paths.config && !inside(paths.config, paths.legacyConfig) && !inside(paths.data, paths.legacyConfig)) await add('config', paths.legacyConfig);
  }
  if (selection.scopes.includes('credential')) items.push({ scope: 'credential', target: options.credentialLabel, present: options.credentialPresent === true });
  return items;
}

/**
 * Removes one planned file or folder: never a symlink, never the home or ~/.claude, never outside
 * the home. A registered custom ledger may live outside the home; only its database files go.
 */
export async function removeTarget(homeReal: string, item: PlannedDeletion): Promise<boolean> {
  if (!item.present) return true;
  const claude = join(homeReal, '.claude');
  let st;
  try {
    st = await lstat(item.target);
  } catch {
    return true;
  }
  if (st.isSymbolicLink()) return false;
  let real: string;
  try {
    real = await realpath(item.target);
  } catch {
    return false;
  }
  if (real !== resolve(item.target) || real === homeReal || inside(claude, real)) return false;
  if (!inside(homeReal, real)) return false;
  await rm(item.target, { recursive: true, force: true });
  return true;
}

export interface DataDeleteCommandInput {
  readonly home: string;
  readonly json: boolean;
  readonly values: { readonly [key: string]: string | boolean | undefined };
  readonly serviceExec?: ServiceExec;
  readonly openKeyring?: OpenHostSecret;
}

type Write = (text: string) => void;

/** `jevris data delete`: plan, refuse while the kill switch is stopped, stop the sidecar, delete. */
export async function runDataDelete(input: DataDeleteCommandInput, write: Write, usage: (problem: string) => number): Promise<number> {
  const { home, json } = input;
  const selection = parseScopes(input.values['scope']);
  if (selection === null) return usage(`jevris data delete: --scope takes a comma list of ${[...DATA_SCOPES, 'data', 'all'].join(', ')}`);
  const dryRun = input.values['dry-run'] === true;
  const data = jevrisPaths({ home }).data;
  const scopeNames = [...(selection.whole ? ['data'] : []), ...selection.scopes];
  const { clearHostSecret, credentialStatus, openHostEntry } = await import('./credential.js');
  const open = input.openKeyring ?? openHostEntry;
  const credentialPresent = selection.scopes.includes('credential') ? (await credentialStatus(open)).presence === 'present' : null;
  const plan = await planDeletion(home, selection, { credentialLabel: `keychain entry ${HOST_SECRET_SERVICE} (account ${HOST_SECRET_ACCOUNT})`, credentialPresent });
  const refuse = (reasonCode: string, message: string): number => {
    if (json) write(`${JSON.stringify({ schemaVersion: '1.0', command: 'data delete', home, ok: false, path: data, scopes: scopeNames, reasonCode, message, vendorNotice: VENDOR_NOTICE })}\n`);
    else write(`home: ${home}\n${message}\nrefused (${reasonCode})\n`);
    return COMMAND_EXIT_CODES.usage;
  };
  if (dryRun) {
    if (json) write(`${JSON.stringify({ schemaVersion: '1.0', command: 'data delete', home, ok: true, dryRun: true, path: data, scopes: scopeNames, items: plan, vendorNotice: VENDOR_NOTICE })}\n`);
    else write(`home: ${home}\n${plan.map((item) => `would delete (${item.scope}): ${item.target}${item.present ? '' : ' (not present)'}`).join('\n')}\nnothing was changed (--dry-run)\n${VENDOR_NOTICE}\n`);
    return COMMAND_EXIT_CODES.ok;
  }
  // GOV-04: a stopped kill switch keeps its files and the data; nothing is deleted.
  const ks = await import('./kill-switch.js');
  if (await ks.readKillSwitchStopped(home)) return refuse('KILL_SWITCH_ACTIVE', 'The kill switch is stopped, so its files and the data are kept. Run jevris kill-switch clear first.');
  // IPC-17: the sidecar stops first; its service unit goes only with the whole data folder.
  const { stopSidecarBeforeRemoval } = await import('./global-harness.js');
  const stopped = await stopSidecarBeforeRemoval(home, selection.whole, input.serviceExec);
  if (!stopped.ok) return refuse('SIDECAR_RUNNING', stopped.message);
  let homeReal: string;
  try {
    homeReal = await realpath(resolve(home));
  } catch {
    return refuse('HOME_MISSING', `${home} does not exist`);
  }
  const done: { readonly scope: string; readonly target: string; readonly deleted: boolean }[] = [];
  // The credential first, while the audit trail still exists; the whole data folder last.
  for (const item of plan) {
    if (item.scope !== 'credential') continue;
    let deleted = true;
    if (item.present) {
      try {
        await clearHostSecret(open);
        const { recordCliAudit } = await import('./runtime-commands.js');
        await recordCliAudit('credential.remove', { via: 'data delete' }, home);
      } catch {
        deleted = false;
      }
    }
    done.push({ scope: item.scope, target: item.target, deleted });
  }
  for (const item of plan) {
    if (item.scope === 'credential' || item.scope === 'data') continue;
    if (item.scope === 'capsules' && !(await purgeCapsuleRows(home))) {
      done.push({ scope: item.scope, target: item.target, deleted: false });
      continue;
    }
    if (item.scope === 'learning' && !(await purgeLearningRows(home))) {
      done.push({ scope: item.scope, target: item.target, deleted: false });
      continue;
    }
    done.push({ scope: item.scope, target: item.target, deleted: await removeTarget(homeReal, item) });
  }
  if (selection.whole) {
    const purged = await ks.purgeKillSwitchData(home);
    if (!purged.ok) return refuse(purged.reasonCode, purged.message);
    const { deleteJevrisData } = await import('./uninstall.js');
    const deleted = (await deleteJevrisData({ home })).ok;
    for (const item of plan) if (item.scope === 'data') done.push({ scope: 'data', target: item.target, deleted });
  }
  const ok = done.every((item) => item.deleted);
  if (json) {
    write(`${JSON.stringify({ schemaVersion: '1.0', command: 'data delete', home, ok, path: data, scopes: scopeNames, items: done, vendorNotice: VENDOR_NOTICE })}\n`);
  } else {
    const lines = done.map((item) => (item.deleted ? `deleted ${item.target}` : `${item.target} could not be deleted; check that it is not a symlink and that you own it`));
    write(`home: ${home}\n${lines.join('\n')}\n${ok ? 'removed' : 'refused'}\n${stopped.nextStep === null ? '' : `${stopped.nextStep}\n`}${VENDOR_NOTICE}\n`);
  }
  return ok ? COMMAND_EXIT_CODES.ok : COMMAND_EXIT_CODES.usage;
}
