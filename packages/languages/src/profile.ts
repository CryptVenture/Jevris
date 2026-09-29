/**
 * Language and environment profiling (VER-07, SSOT §15.3, C08, C72, W12).
 *
 * `profileWorkspace` discovers build manifests deterministically (sorted, bounded depth,
 * vendor directories skipped): npm/pnpm/yarn/bun, pyproject, Cargo, go.mod, Maven, Gradle,
 * CMake, .NET (csproj/sln) and PlatformIO. Toolchain versions are probed only when a probe is
 * given, through the platform spawn plan (no shell, PATHEXT and .cmd shims handled).
 *
 * `proposeChecks` is the certified-analyzer registry: each analyzer turns one discovered stack
 * into proposed check manifests (`jevris-checks-1`) and, for device-bound stacks, hardware
 * runner declarations. Proposals are untrusted until the user approves them through the CLI;
 * nothing here runs a check or writes a receipt.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { runSync, type EnvLike } from '@jevris/platform';

export type StackId = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'python' | 'cargo' | 'go' | 'maven' | 'gradle' | 'cmake' | 'dotnet' | 'platformio';

export interface DiscoveredStack {
  readonly stack: StackId;
  /** Workspace-relative posix path of the manifest file. */
  readonly manifest: string;
  /** Workspace-relative posix directory ('.' for the root). */
  readonly dir: string;
  /** The toolchain program the analyzer would run. */
  readonly toolchain: string;
  /** Detected facts the analyzer uses (script names, test framework, wrapper). */
  readonly facts: { readonly [key: string]: string | boolean };
}

export interface ToolchainVersion {
  readonly program: string;
  readonly version: string | null;
}

/**
 * Metadata found in the workspace whether or not a certified analyzer understands it
 * (languages by source extension, project systems by project file). It says what exists; it
 * never implies Jevris knows how to build or test it (W12).
 */
export interface DetectedMetadata {
  readonly kind: 'language' | 'project';
  readonly id: string;
  /** The first matching workspace-relative posix path (sorted walk). */
  readonly evidence: string;
  readonly count: number;
}

export interface WorkspaceProfile {
  readonly schemaVersion: 'jevris-profile-1';
  readonly stacks: readonly DiscoveredStack[];
  readonly metadata: readonly DetectedMetadata[];
  readonly toolchains: readonly ToolchainVersion[];
  /** True when discovery stopped at a bound; the profile is then partial. */
  readonly truncated: boolean;
}

export type VersionProbe = (program: string, args: readonly string[]) => string | null;

export interface ProfileOptions {
  readonly maxDepth?: number;
  readonly platform?: string;
  /** When given, toolchain versions are probed; otherwise versions are null. */
  readonly probe?: VersionProbe;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', 'venv', '__pycache__', '.jevris', 'vendor', 'out', 'bin', 'obj', '.gradle', '.idea', '.next', '.pio']); // path-hygiene: allow workspace-relative directory names
const MAX_DIRS = 2_000;

/** Source extensions by language (lower case). */
const LANGUAGE_EXT: { readonly [ext: string]: string } = {
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.s': 'assembly',
  '.asm': 'assembly',
  '.ino': 'arduino',
  '.rs': 'rust',
  '.go': 'go',
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.ts': 'typescript',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.vhd': 'vhdl',
  '.vhdl': 'vhdl',
  '.v': 'verilog',
  '.sv': 'systemverilog',
};

/** Project files by build or IDE system: exact names, or an extension (lower case). */
const PROJECT_FILES: readonly { readonly id: string; readonly name?: string; readonly ext?: string }[] = [
  { id: 'keil-uvision', ext: '.uvprojx' },
  { id: 'keil-uvision', ext: '.uvproj' },
  { id: 'iar-embedded-workbench', ext: '.ewp' },
  { id: 'mplab-x', name: 'Makefile-default.mk' },
  { id: 'stm32cube', ext: '.ioc' },
  { id: 'eclipse-cdt', name: '.cproject' },
  { id: 'make', name: 'Makefile' },
  { id: 'make', name: 'makefile' },
  { id: 'meson', name: 'meson.build' },
  { id: 'bazel', name: 'BUILD.bazel' },
  { id: 'bazel', name: 'WORKSPACE' },
  { id: 'scons', name: 'SConstruct' },
  { id: 'xcode', ext: '.xcodeproj' },
  { id: 'visual-studio', ext: '.vcxproj' },
  { id: 'arduino', name: 'sketch.yaml' },
  { id: 'zephyr', name: 'prj.conf' },
  { id: 'gemfile', name: 'Gemfile' },
  { id: 'composer', name: 'composer.json' },
];

const MAX_METADATA = 64;

function extOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at <= 0 ? '' : name.slice(at).toLowerCase();
}

function noteMetadata(found: Map<string, { kind: 'language' | 'project'; id: string; evidence: string; count: number }>, kind: 'language' | 'project', id: string, path: string): void {
  const key = `${kind}:${id}`;
  const prior = found.get(key);
  if (prior !== undefined) prior.count += 1;
  else if (found.size < MAX_METADATA) found.set(key, { kind, id, evidence: path, count: 1 });
}
const MAX_MANIFEST_BYTES = 1024 * 1024;
const NPM_DEFAULT_TEST = /no test specified/;

function posixRel(root: string, path: string): string {
  const rel = relative(root, path).split('\\').join('/');
  return rel === '' ? '.' : rel;
}

function readText(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function has(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

function list(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function discoverIn(root: string, dir: string, names: readonly string[], out: DiscoveredStack[]): void {
  const at = posixRel(root, dir);
  const file = (name: string) => posix.join(at, name);
  if (names.includes('package.json')) {
    const text = readText(join(dir, 'package.json'));
    let scripts: { [key: string]: unknown } = {};
    try {
      const parsed: unknown = text === null ? null : JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const s = (parsed as { scripts?: unknown }).scripts;
        if (s !== null && typeof s === 'object' && !Array.isArray(s)) scripts = s as { [key: string]: unknown };
      }
    } catch {
      scripts = {};
    }
    const stack: StackId = names.includes('pnpm-lock.yaml')
      ? 'pnpm'
      : names.includes('yarn.lock')
        ? 'yarn'
        : names.includes('bun.lockb') || names.includes('bun.lock')
          ? 'bun'
          : 'npm';
    const facts: { [key: string]: string | boolean } = {};
    for (const name of ['test', 'lint', 'typecheck']) {
      const script = scripts[name];
      if (typeof script === 'string' && !(name === 'test' && NPM_DEFAULT_TEST.test(script))) facts[`script:${name}`] = true;
    }
    out.push({ stack, manifest: file('package.json'), dir: at, toolchain: stack, facts });
  }
  if (names.includes('pyproject.toml')) {
    const text = readText(join(dir, 'pyproject.toml')) ?? '';
    const runner = names.includes('uv.lock') ? 'uv' : names.includes('poetry.lock') ? 'poetry' : 'python';
    const pytest = /\[tool\.pytest|pytest/.test(text) || names.includes('tests') || names.includes('pytest.ini');
    out.push({ stack: 'python', manifest: file('pyproject.toml'), dir: at, toolchain: runner, facts: { pytest, runner } });
  }
  if (names.includes('Cargo.toml')) out.push({ stack: 'cargo', manifest: file('Cargo.toml'), dir: at, toolchain: 'cargo', facts: {} });
  if (names.includes('go.mod')) out.push({ stack: 'go', manifest: file('go.mod'), dir: at, toolchain: 'go', facts: {} });
  if (names.includes('pom.xml')) out.push({ stack: 'maven', manifest: file('pom.xml'), dir: at, toolchain: names.includes('mvnw') ? 'mvnw' : 'mvn', facts: { wrapper: names.includes('mvnw') } });
  const gradle = names.find((n) => n === 'build.gradle' || n === 'build.gradle.kts' || n === 'settings.gradle' || n === 'settings.gradle.kts');
  if (gradle !== undefined) {
    out.push({ stack: 'gradle', manifest: file(gradle), dir: at, toolchain: names.includes('gradlew') ? 'gradlew' : 'gradle', facts: { wrapper: names.includes('gradlew') } });
  }
  if (names.includes('CMakeLists.txt')) out.push({ stack: 'cmake', manifest: file('CMakeLists.txt'), dir: at, toolchain: 'ctest', facts: {} });
  const dotnet = names.find((n) => n.endsWith('.sln')) ?? names.find((n) => n.endsWith('.csproj') || n.endsWith('.fsproj'));
  if (dotnet !== undefined) out.push({ stack: 'dotnet', manifest: file(dotnet), dir: at, toolchain: 'dotnet', facts: {} });
  if (names.includes('platformio.ini')) out.push({ stack: 'platformio', manifest: file('platformio.ini'), dir: at, toolchain: 'pio', facts: {} });
}

const VERSION_ARGS: { readonly [program: string]: readonly string[] } = {
  npm: ['--version'],
  pnpm: ['--version'],
  yarn: ['--version'],
  bun: ['--version'],
  node: ['--version'],
  python: ['--version'],
  python3: ['--version'],
  uv: ['--version'],
  poetry: ['--version'],
  cargo: ['--version'],
  go: ['version'],
  mvn: ['--version'],
  gradle: ['--version'],
  ctest: ['--version'],
  cmake: ['--version'],
  dotnet: ['--version'],
  pio: ['--version'],
};

/** The default probe: runs `<program> --version` without a shell, first output line only. */
export function spawnVersionProbe(env: EnvLike = process.env, timeoutMs = 5_000): VersionProbe {
  return (program, args) => {
    const result = runSync(program, args, { env, timeoutMs, spawnEnv: env });
    if (!result.ok) return null;
    const line = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((l) => l.trim().length > 0);
    return line === undefined ? null : line.trim().slice(0, 120);
  };
}

export function profileWorkspace(root: string, options: ProfileOptions = {}): WorkspaceProfile {
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 2, 4));
  const stacks: DiscoveredStack[] = [];
  const found = new Map<string, { kind: 'language' | 'project'; id: string; evidence: string; count: number }>();
  let visited = 0;
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (visited >= MAX_DIRS) {
      truncated = true;
      return;
    }
    visited += 1;
    const names = list(dir);
    discoverIn(root, dir, names, stacks);
    for (const name of names) {
      if (SKIP.has(name)) continue;
      const rel = posix.join(posixRel(root, dir), name);
      const ext = extOf(name);
      const language = LANGUAGE_EXT[ext];
      if (language !== undefined) noteMetadata(found, 'language', language, rel);
      const project = PROJECT_FILES.find((p) => (p.name !== undefined && p.name === name) || (p.ext !== undefined && p.ext === ext));
      if (project !== undefined) noteMetadata(found, 'project', project.id, rel);
    }
    if (depth >= maxDepth) return;
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const child = join(dir, name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  stacks.sort((a, b) => (a.dir === b.dir ? (a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0) : a.dir === '.' ? -1 : b.dir === '.' ? 1 : a.dir < b.dir ? -1 : 1));
  const programs = new Set<string>(stacks.length > 0 && stacks.some((s) => ['npm', 'pnpm', 'yarn'].includes(s.stack)) ? ['node'] : []);
  for (const s of stacks) {
    const program = s.toolchain === 'gradlew' ? 'gradle' : s.toolchain === 'mvnw' ? 'mvn' : s.toolchain;
    programs.add(program === 'python' && (options.platform ?? process.platform) !== 'win32' ? 'python3' : program);
  }
  const toolchains = [...programs].sort().map((program) => ({
    program,
    version: options.probe === undefined ? null : options.probe(program, VERSION_ARGS[program] ?? ['--version']),
  }));
  const metadata = [...found.values()]
    .map((m) => ({ kind: m.kind, id: m.id, evidence: m.evidence, count: m.count }))
    .sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind === 'project' ? -1 : 1));
  return { schemaVersion: 'jevris-profile-1', stacks, metadata, toolchains, truncated };
}

// ------------------------------------------------------------------ certified-analyzer registry

export interface ProposedCheck {
  readonly id: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly resultFormat: 'auto';
  readonly timeoutMs: number;
  readonly mandatory: boolean;
  readonly inputScopes: readonly string[];
  readonly description: string;
  readonly hardware?: string;
}

export interface HardwareRunnerDeclaration {
  readonly hardware: string;
  readonly checkIds: readonly string[];
  /** A declared hardware runner is not available until the user attaches one. */
  readonly availability: 'declared-unattached';
  readonly description: string;
}

export interface CheckProposal {
  readonly schemaVersion: 'jevris-checks-1';
  readonly analyzers: readonly { readonly id: string; readonly version: string; readonly stack: StackId; readonly dir: string }[];
  readonly checks: readonly ProposedCheck[];
  readonly hardwareRunners: readonly HardwareRunnerDeclaration[];
  /** Everything the profile detected, understood or not. */
  readonly detected: readonly DetectedMetadata[];
  /**
   * How much of the detected workspace has certified build/test semantics (W12):
   * 'proposed' — every detected language is covered by a proposing analyzer;
   * 'partial' — checks were proposed, but some detected metadata is not understood;
   * 'unverified' — metadata was detected but no certified analyzer proposed a check, so the
   *   build and test semantics are unverified;
   * 'nothing-detected' — no metadata and no checks.
   */
  readonly semantics: 'proposed' | 'partial' | 'unverified' | 'nothing-detected';
  /** The detected metadata no certified analyzer covers. */
  readonly unverified: readonly DetectedMetadata[];
}

/** Metadata a certified analyzer's stack covers (so it is not reported as unverified). */
const COVERED: { readonly [stack in StackId]: readonly string[] } = {
  npm: ['javascript', 'typescript'],
  pnpm: ['javascript', 'typescript'],
  yarn: ['javascript', 'typescript'],
  bun: ['javascript', 'typescript'],
  python: ['python'],
  cargo: ['rust'],
  go: ['go'],
  maven: ['java', 'kotlin'],
  gradle: ['java', 'kotlin'],
  cmake: ['c', 'cpp', 'assembly'],
  dotnet: ['csharp'],
  platformio: ['c', 'cpp', 'arduino', 'assembly'],
};

export interface CertifiedAnalyzer {
  readonly id: string;
  readonly version: string;
  readonly stack: StackId;
  propose(stack: DiscoveredStack, context: { readonly root: string; readonly platform: string }): readonly ProposedCheck[];
}

const TEN_MIN = 600_000;

function slug(dir: string): string {
  return dir === '.' ? '' : `${dir.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}-`;
}

function check(stack: DiscoveredStack, name: string, argv: readonly string[], description: string, extra: Partial<ProposedCheck> = {}): ProposedCheck {
  return {
    id: `${slug(stack.dir)}${name}`,
    argv,
    cwd: stack.dir,
    resultFormat: 'auto',
    timeoutMs: TEN_MIN,
    mandatory: true,
    inputScopes: stack.dir === '.' ? [] : [stack.dir],
    description,
    ...extra,
  };
}

const JS: CertifiedAnalyzer['propose'] = (s) => {
  const pm = s.stack;
  const out: ProposedCheck[] = [];
  if (s.facts['script:test'] === true) out.push(check(s, 'test', [pm, 'test'], `${pm} test`));
  if (s.facts['script:lint'] === true) out.push(check(s, 'lint', [pm, 'run', 'lint'], `${pm} run lint`));
  if (s.facts['script:typecheck'] === true) out.push(check(s, 'typecheck', [pm, 'run', 'typecheck'], `${pm} run typecheck`));
  return out;
};

export const CERTIFIED_ANALYZERS: readonly CertifiedAnalyzer[] = Object.freeze([
  { id: 'jevris.npm', version: '1', stack: 'npm', propose: JS },
  { id: 'jevris.pnpm', version: '1', stack: 'pnpm', propose: JS },
  { id: 'jevris.yarn', version: '1', stack: 'yarn', propose: JS },
  { id: 'jevris.bun', version: '1', stack: 'bun', propose: JS },
  {
    id: 'jevris.python',
    version: '1',
    stack: 'python',
    propose: (s, { platform }) => {
      if (s.facts['pytest'] !== true) return [];
      const runner = s.facts['runner'];
      const argv =
        runner === 'uv' ? ['uv', 'run', 'pytest', '-q'] : runner === 'poetry' ? ['poetry', 'run', 'pytest', '-q'] : [platform === 'win32' ? 'python' : 'python3', '-m', 'pytest', '-q'];
      return [check(s, 'pytest', argv, 'pytest')];
    },
  },
  { id: 'jevris.cargo', version: '1', stack: 'cargo', propose: (s) => [check(s, 'cargo-test', ['cargo', 'test', '--quiet'], 'cargo test')] },
  { id: 'jevris.go', version: '1', stack: 'go', propose: (s) => [check(s, 'go-test', ['go', 'test', './...'], 'go test ./...')] },
  {
    id: 'jevris.maven',
    version: '1',
    stack: 'maven',
    propose: (s, { root, platform }) => [
      check(s, 'mvn-test', [s.facts['wrapper'] === true ? join(root, s.dir, platform === 'win32' ? 'mvnw.cmd' : 'mvnw') : 'mvn', '-q', 'test'], 'maven test', {
        timeoutMs: 2 * TEN_MIN,
      }),
    ],
  },
  {
    id: 'jevris.gradle',
    version: '1',
    stack: 'gradle',
    propose: (s, { root, platform }) => [
      check(s, 'gradle-test', [s.facts['wrapper'] === true ? join(root, s.dir, platform === 'win32' ? 'gradlew.bat' : 'gradlew') : 'gradle', 'test', '--quiet'], 'gradle test', {
        timeoutMs: 2 * TEN_MIN,
      }),
    ],
  },
  { id: 'jevris.cmake', version: '1', stack: 'cmake', propose: (s) => [check(s, 'ctest', ['ctest', '--test-dir', 'build', '--output-on-failure'], 'ctest (configure and build into ./build first)')] },
  { id: 'jevris.dotnet', version: '1', stack: 'dotnet', propose: (s) => [check(s, 'dotnet-test', ['dotnet', 'test', '--nologo'], 'dotnet test', { timeoutMs: 2 * TEN_MIN })] },
  {
    id: 'jevris.platformio',
    version: '1',
    stack: 'platformio',
    propose: (s) => [
      check(s, 'pio-test-native', ['pio', 'test', '-e', 'native'], 'PlatformIO native tests', { mandatory: false }),
      check(s, 'pio-test-device', ['pio', 'test'], 'PlatformIO on-device tests', { hardware: 'platformio-device' }),
    ],
  },
]);

/** Runs the certified analyzers over a profile. Deterministic; proposals still need approval. */
export function proposeChecks(profile: WorkspaceProfile, root: string, platform: string = process.platform): CheckProposal {
  const checks: ProposedCheck[] = [];
  const analyzers: { id: string; version: string; stack: StackId; dir: string }[] = [];
  const seen = new Set<string>();
  for (const stack of profile.stacks) {
    const analyzer = CERTIFIED_ANALYZERS.find((a) => a.stack === stack.stack);
    if (analyzer === undefined) continue;
    const proposed = analyzer.propose(stack, { root, platform });
    if (proposed.length === 0) continue;
    analyzers.push({ id: analyzer.id, version: analyzer.version, stack: stack.stack, dir: stack.dir });
    for (const c of proposed) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      checks.push(c);
    }
  }
  const byHardware = new Map<string, string[]>();
  for (const c of checks) if (c.hardware !== undefined) byHardware.set(c.hardware, [...(byHardware.get(c.hardware) ?? []), c.id]);
  const hardwareRunners = [...byHardware.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([hardware, checkIds]) => ({
      hardware,
      checkIds,
      availability: 'declared-unattached' as const,
      description: `Checks that need ${hardware} run only on a runner that declares it; elsewhere they record not-run.`,
    }));
  const covered = new Set(analyzers.flatMap((a) => COVERED[a.stack]));
  const detected = profile.metadata ?? [];
  const unverified = detected.filter((m) => !(m.kind === 'language' && covered.has(m.id)));
  const semantics = checks.length === 0 ? (detected.length === 0 ? 'nothing-detected' : 'unverified') : unverified.length > 0 ? 'partial' : 'proposed';
  return { schemaVersion: 'jevris-checks-1', analyzers, checks, hardwareRunners, detected, semantics, unverified };
}
