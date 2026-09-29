import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { isAbsoluteFor, runSync } from '@jevris/platform';

/**
 * Per-user service units for the sidecar (IPC-20, SSOT §5.1, R13): `jevris service
 * install|uninstall|status`.
 *
 *   macOS    a LaunchAgent, ~/Library/LaunchAgents/dev.jevris.sidecar.plist (launchctl)
 *   Linux    a systemd user unit, ~/.config/systemd/user/jevris-sidecar.service (systemctl --user)
 *   Windows  a per-user Scheduled Task, \Jevris\Sidecar, started at logon (schtasks)
 *
 * Each runs `sidecar run --supervised` (no idle exit) and restarts it when it crashes, but not
 * when it stops cleanly: `jevris sidecar stop` is respected until the next login or install.
 * The unit text is generated here and golden-tested; every command runs without a shell.
 */

export const LAUNCH_AGENT_LABEL = 'dev.jevris.sidecar';
export const SYSTEMD_UNIT_NAME = 'jevris-sidecar.service';
export const SCHEDULED_TASK_NAME = '\\Jevris\\Sidecar';

export type ServicePlatform = 'darwin' | 'linux' | 'win32';

export interface ServiceInput {
  readonly platform: ServicePlatform;
  /** The user's OS home (not JEVRIS_HOME): where per-user units live. */
  readonly osHome: string;
  /** The Jevris state directory (logs, the task XML). */
  readonly stateDir: string;
  /** The full command line: node, the sidecar entry and its arguments. */
  readonly argv: readonly string[];
  /** Set when a non-default Jevris home is served. */
  readonly jevrisHome?: string;
  /** POSIX uid, for launchctl's gui/<uid> domain. */
  readonly uid?: number;
  /** Windows DOMAIN\\user, for the task's logon trigger and principal. */
  readonly windowsUser?: string;
  readonly env?: { readonly [key: string]: string | undefined };
}

export interface ServicePlan {
  readonly platform: ServicePlatform;
  readonly unitPath: string;
  readonly unitText: string;
  /** schtasks reads a task definition as UTF-16. */
  readonly encoding: 'utf8' | 'utf16le';
  readonly manager: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** One systemd ExecStart word: quoted, with backslash, quote, % and $ escaped. */
function systemdWord(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** One Windows command-line argument, quoted by the CommandLineToArgvW rules. */
export function windowsArg(value: string): string {
  if (value.length > 0 && !/[\s"]/.test(value)) return value;
  let out = '"';
  let slashes = 0;
  for (const ch of value) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
    } else {
      out += '\\'.repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

export function launchAgentPlist(input: ServiceInput): string {
  const args = input.argv.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n');
  // The plist is macOS text whatever host renders it, so its log path uses POSIX separators.
  const log = xmlEscape(posix.join(input.stateDir, 'logs', 'service.log'));
  const env = input.jevrisHome !== undefined ? `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>JEVRIS_HOME</key>\n    <string>${xmlEscape(input.jevrisHome)}</string>\n  </dict>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
${env}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export function systemdUnit(input: ServiceInput): string {
  const env = input.jevrisHome !== undefined ? `Environment=${systemdWord(`JEVRIS_HOME=${input.jevrisHome}`)}\n` : '';
  return `[Unit]
Description=Jevris sidecar (local decision service)

[Service]
Type=simple
ExecStart=${input.argv.map(systemdWord).join(' ')}
${env}Restart=on-failure
RestartSec=5
StartLimitIntervalSec=300
StartLimitBurst=10
UMask=0077

[Install]
WantedBy=default.target
`;
}

export function scheduledTaskXml(input: ServiceInput): string {
  const [command, ...rest] = input.argv;
  const user = xmlEscape(input.windowsUser ?? '');
  const env = input.jevrisHome !== undefined ? ['--home', input.jevrisHome] : [];
  const args = xmlEscape([...rest, ...env].map(windowsArg).join(' '));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Jevris sidecar (local decision service)</Description>
    <URI>${xmlEscape(SCHEDULED_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command ?? '')}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function planService(input: ServiceInput): ServicePlan {
  if (input.platform === 'darwin') {
    return { platform: 'darwin', unitPath: join(input.osHome, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`), unitText: launchAgentPlist(input), encoding: 'utf8', manager: 'launchd' };
  }
  if (input.platform === 'linux') {
    const xdg = input.env?.['XDG_CONFIG_HOME'];
    const base = typeof xdg === 'string' && isAbsoluteFor(xdg, 'linux') ? xdg : join(input.osHome, '.config');
    return { platform: 'linux', unitPath: join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME), unitText: systemdUnit(input), encoding: 'utf8', manager: 'systemd --user' };
  }
  return { platform: 'win32', unitPath: join(input.stateDir, 'jevris-sidecar-task.xml'), unitText: scheduledTaskXml(input), encoding: 'utf16le', manager: 'Task Scheduler' };
}

// ------------------------------------------------------------------ install, uninstall, status

export type Exec = (file: string, args: readonly string[]) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };

export interface ServiceResult {
  readonly ok: boolean;
  readonly state: 'installed' | 'not-installed' | 'running' | 'stopped' | 'unsupported' | 'failed' | 'other-home' | 'unknown';
  readonly unitPath: string;
  readonly manager: string;
  readonly pid: number | null;
  readonly steps: readonly { readonly step: string; readonly ok: boolean; readonly detail?: string }[];
  readonly message: string;
}

function defaultExec(env: { readonly [key: string]: string | undefined } | undefined): Exec {
  return (file, args) => {
    const out = runSync(file, args, { ...(env !== undefined ? { env, spawnEnv: env } : {}), timeoutMs: 20_000 });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  };
}

function tool(platform: ServicePlatform, name: 'launchctl' | 'systemctl' | 'schtasks', env: ServiceInput['env']): string {
  if (name === 'launchctl') return '/bin/launchctl';
  if (name === 'schtasks') return win32.join(env?.['SystemRoot'] ?? env?.['SYSTEMROOT'] ?? 'C:\\Windows', 'System32', 'schtasks.exe');
  return platform === 'linux' ? 'systemctl' : name;
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '').trim().slice(0, 200);
}

function writeUnit(plan: ServicePlan): boolean {
  try {
    mkdirSync(join(plan.unitPath, '..'), { recursive: true, mode: 0o700 });
    const bytes = plan.encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan.unitText, 'utf16le')]) : plan.unitText;
    writeFileSync(plan.unitPath, bytes, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Writes the unit and registers it with the service manager, then starts it. */
export function installService(input: ServiceInput, exec: Exec = defaultExec(input.env)): ServiceResult {
  const plan = planService(input);
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  const done = (ok: boolean, message: string): ServiceResult => ({ ok, state: ok ? 'installed' : 'failed', unitPath: plan.unitPath, manager: plan.manager, pid: null, steps, message });
  if (input.platform === 'darwin') mkdirSync(join(input.stateDir, 'logs'), { recursive: true, mode: 0o700 });
  const wrote = writeUnit(plan);
  steps.push({ step: 'write unit', ok: wrote });
  if (!wrote) return done(false, `The unit file ${plan.unitPath} could not be written.`);
  const run = (step: string, file: string, args: readonly string[], allowFail = false): boolean => {
    const out = exec(file, args);
    const ok = out.status === 0;
    steps.push({ step, ok: ok || allowFail, ...(ok ? {} : { detail: firstLine(out.stderr || out.stdout) || `exit ${String(out.status)}` }) });
    return ok || allowFail;
  };
  if (input.platform === 'darwin') {
    const domain = `gui/${String(input.uid ?? 0)}`;
    const launchctl = tool('darwin', 'launchctl', input.env);
    // A previous registration is replaced.
    run('bootout previous', launchctl, ['bootout', `${domain}/${LAUNCH_AGENT_LABEL}`], true); // path-hygiene: allow launchd service target, not a file path
    if (!run('bootstrap', launchctl, ['bootstrap', domain, plan.unitPath])) return done(false, 'launchctl refused the LaunchAgent. See the steps.');
    run('kickstart', launchctl, ['kickstart', `${domain}/${LAUNCH_AGENT_LABEL}`], true); // path-hygiene: allow launchd service target, not a file path
    return done(true, 'The Jevris sidecar LaunchAgent is installed and starts at login; launchd restarts it if it crashes.');
  }
  if (input.platform === 'linux') {
    const systemctl = tool('linux', 'systemctl', input.env);
    if (!run('daemon-reload', systemctl, ['--user', 'daemon-reload'])) {
      return { ...done(false, 'No systemd user session is available here (for example a container or a CI job). The sidecar still starts on demand.'), state: 'unsupported' };
    }
    if (!run('enable --now', systemctl, ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME])) return done(false, 'systemctl could not enable the unit. See the steps.');
    return done(true, 'The Jevris sidecar systemd user unit is enabled; systemd restarts it if it crashes.');
  }
  const schtasks = tool('win32', 'schtasks', input.env);
  if (!run('create task', schtasks, ['/Create', '/TN', SCHEDULED_TASK_NAME, '/XML', plan.unitPath, '/F'])) return done(false, 'Task Scheduler refused the task. See the steps.');
  run('run task', schtasks, ['/Run', '/TN', SCHEDULED_TASK_NAME], true);
  return done(true, 'The Jevris sidecar task is installed and starts at logon; Task Scheduler restarts it if it fails.');
}

/** Stops and unregisters the unit and removes its file. Nothing installed is not an error. */
/**
 * The part of a unit that names the Jevris home it serves: from `--home` to the end of that
 * argument in the unit's own format, or null when the unit serves the OS default home.
 */
export function unitHomeFragment(text: string): string | null {
  const at = text.indexOf('--home');
  if (at < 0) return null;
  const rest = text.slice(at);
  const plist = /^--home<\/string>\s*<string>[^<]*<\/string>/.exec(rest);
  if (plist !== null) return plist[0].replace(/\s+/g, ' ');
  const end = rest.search(/<\/Arguments>|\r?\n/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** Whether an installed unit's text serves the same Jevris home as this input's unit would. */
export function unitServesHome(installed: string, input: ServiceInput): boolean {
  return unitHomeFragment(installed) === unitHomeFragment(planService(input).unitText);
}

export function uninstallService(input: ServiceInput, exec: Exec = defaultExec(input.env)): ServiceResult {
  const plan = planService(input);
  const steps: { step: string; ok: boolean; detail?: string }[] = [];
  let present = existsSync(plan.unitPath);
  // The unit is one per OS account, whatever home it serves: a unit for another Jevris home is
  // left in place (IPC-17: removing a test or secondary home never removes the owner's service).
  const otherHome = (): ServiceResult => ({
    ok: false,
    state: 'other-home',
    unitPath: plan.unitPath,
    manager: plan.manager,
    pid: null,
    steps,
    message: 'The installed Jevris sidecar service serves another Jevris home, so it was left in place. Run `jevris service uninstall` with that home to remove it.',
  });
  if (input.platform === 'win32') {
    const query = exec(tool('win32', 'schtasks', input.env), ['/Query', '/TN', SCHEDULED_TASK_NAME, '/XML']);
    if (query.status === 0 && !unitServesHome(query.stdout, input)) return otherHome();
    if (query.status !== 0 && !present) {
      return { ok: true, state: 'not-installed', unitPath: plan.unitPath, manager: plan.manager, pid: null, steps, message: 'No Jevris sidecar service was installed.' };
    }
    present = present || query.status === 0;
  } else if (present) {
    const installed = readUnit(plan);
    if (installed !== undefined && !unitServesHome(installed, input)) return otherHome();
  }
  const quiet = (step: string, file: string, args: readonly string[]): void => {
    const out = exec(file, args);
    steps.push({ step, ok: true, ...(out.status === 0 ? {} : { detail: firstLine(out.stderr || out.stdout) || `exit ${String(out.status)}` }) });
  };
  if (input.platform === 'darwin') {
    quiet('bootout', tool('darwin', 'launchctl', input.env), ['bootout', `gui/${String(input.uid ?? 0)}/${LAUNCH_AGENT_LABEL}`]); // path-hygiene: allow launchd service target, not a file path
  } else if (input.platform === 'linux') {
    const systemctl = tool('linux', 'systemctl', input.env);
    if (present) quiet('disable --now', systemctl, ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]);
  } else {
    const schtasks = tool('win32', 'schtasks', input.env);
    quiet('end task', schtasks, ['/End', '/TN', SCHEDULED_TASK_NAME]);
    quiet('delete task', schtasks, ['/Delete', '/TN', SCHEDULED_TASK_NAME, '/F']);
  }
  let removed = true;
  if (present && existsSync(plan.unitPath)) {
    try {
      unlinkSync(plan.unitPath);
    } catch {
      removed = false;
    }
    steps.push({ step: 'remove unit', ok: removed });
  }
  if (input.platform === 'linux' && present) quiet('daemon-reload', tool('linux', 'systemctl', input.env), ['--user', 'daemon-reload']);
  return {
    ok: removed,
    state: removed ? 'not-installed' : 'failed',
    unitPath: plan.unitPath,
    manager: plan.manager,
    pid: null,
    steps,
    message: removed ? (present ? 'The Jevris sidecar service is removed.' : 'No Jevris sidecar service was installed.') : `The unit file ${plan.unitPath} could not be removed.`,
  };
}

/** Whether the unit is installed, and whether the service manager reports it running. */
export function serviceStatus(input: ServiceInput, exec: Exec = defaultExec(input.env)): ServiceResult {
  const plan = planService(input);
  const base = { unitPath: plan.unitPath, manager: plan.manager, steps: [] as const };
  if (input.platform === 'darwin') {
    const out = exec(tool('darwin', 'launchctl', input.env), ['print', `gui/${String(input.uid ?? 0)}/${LAUNCH_AGENT_LABEL}`]); // path-hygiene: allow launchd service target, not a file path
    if (out.status !== 0) return { ...base, ok: true, state: existsSync(plan.unitPath) ? 'installed' : 'not-installed', pid: null, message: existsSync(plan.unitPath) ? 'The LaunchAgent file exists but launchd has not loaded it. Run `jevris service install`.' : 'No Jevris sidecar service is installed; the sidecar starts on demand.' };
    const running = /^\s*state = running\s*$/m.test(out.stdout);
    const pid = /^\s*pid = (\d+)\s*$/m.exec(out.stdout);
    return { ...base, ok: true, state: running ? 'running' : 'stopped', pid: pid !== null ? Number(pid[1]) : null, message: running ? 'launchd runs the Jevris sidecar.' : 'The LaunchAgent is loaded; the sidecar is not running now (it starts at login, or after a crash).' };
  }
  if (input.platform === 'linux') {
    if (!existsSync(plan.unitPath)) return { ...base, ok: true, state: 'not-installed', pid: null, message: 'No Jevris sidecar service is installed; the sidecar starts on demand.' };
    const out = exec(tool('linux', 'systemctl', input.env), ['--user', 'show', SYSTEMD_UNIT_NAME, '--property=ActiveState,MainPID']);
    // No systemd user session (a container, WSL without systemd, CI): the unit is on disk, its
    // state cannot be read. Status still answers; the sidecar starts on demand.
    if (out.status !== 0) return { ...base, ok: true, state: 'unknown', pid: null, message: 'The unit file exists, but no systemd user session answered; the sidecar starts on demand.' };
    const active = /^ActiveState=(\S+)$/m.exec(out.stdout)?.[1] ?? 'unknown';
    const mainPid = Number(/^MainPID=(\d+)$/m.exec(out.stdout)?.[1] ?? '0');
    return { ...base, ok: true, state: active === 'active' ? 'running' : 'stopped', pid: mainPid > 0 ? mainPid : null, message: `systemd reports the unit ${active}.` };
  }
  const out = exec(tool('win32', 'schtasks', input.env), ['/Query', '/TN', SCHEDULED_TASK_NAME, '/FO', 'LIST']);
  if (out.status !== 0) return { ...base, ok: true, state: 'not-installed', pid: null, message: 'No Jevris sidecar task is installed; the sidecar starts on demand.' };
  const status = /^Status:\s*(.+)$/m.exec(out.stdout)?.[1]?.trim() ?? 'unknown';
  return { ...base, ok: true, state: /^Running$/i.test(status) ? 'running' : 'stopped', pid: null, message: `Task Scheduler reports the task ${status}.` };
}

/** Reads back the unit file this module wrote (for status output and tests). */
export function readUnit(plan: ServicePlan): string | undefined {
  try {
    const bytes = readFileSync(plan.unitPath);
    return plan.encoding === 'utf16le' ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8');
  } catch {
    return undefined;
  }
}
