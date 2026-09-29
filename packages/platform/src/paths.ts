import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/**
 * The only source of Jevris directories (BLD-02).
 *
 * | OS     | config                         | data                          | state                          | runtime      |
 * | darwin | ~/.config/jevris               | ~/.jevris                     | ~/.jevris                      | ~/.jevris/run |
 * | linux  | $XDG_CONFIG_HOME/jevris        | $XDG_DATA_HOME/jevris         | $XDG_STATE_HOME/jevris         | <state>/run  |
 * | win32  | %APPDATA%\Jevris               | %LOCALAPPDATA%\Jevris         | <data>\state                   | <data>\run   |
 *
 * The home is `home` (an explicit --home), else JEVRIS_HOME, else the OS home. The OS
 * variables (XDG_*, APPDATA, LOCALAPPDATA) apply only for the OS home with JEVRIS_HOME
 * unset; otherwise the default sub-paths under the chosen home are used, so every path
 * stays inside the home the caller named.
 */

export interface EnvLike {
  readonly [key: string]: string | undefined;
}

export interface JevrisPathsInput {
  /** An explicit home, such as the CLI --home flag. */
  readonly home?: string;
  readonly platform?: string;
  readonly env?: EnvLike;
  /** Injected os.homedir() for tests. */
  readonly osHome?: string;
}

export type HomeSource = 'explicit' | 'JEVRIS_HOME' | 'os';

export interface JevrisPaths {
  readonly platform: string;
  readonly home: string;
  readonly homeSource: HomeSource;
  /** Host and organization policy, policy history, the calibration release. */
  readonly config: string;
  /** Packs, install receipts, ledgers. */
  readonly data: string;
  /** Logs and other state that should persist but is not user data. */
  readonly state: string;
  /** The sidecar socket directory. */
  readonly runtime: string;
  /** The pre-v1.2 locations, which migrateLegacyLayout moves from. */
  readonly legacyConfig: string;
  readonly legacyData: string;
}

type PathApi = typeof posix;

export function pathApiFor(platform: string): PathApi {
  return platform === 'win32' ? win32 : posix;
}

/** Reads an environment variable; case-insensitive on win32 like the real environment. */
export function envValue(env: EnvLike, name: string, platform: string): string | undefined {
  const direct = env[name];
  if (typeof direct === 'string') return direct;
  if (platform !== 'win32') return undefined;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper) {
      const value = env[key];
      if (typeof value === 'string') return value;
    }
  }
  return undefined;
}

function usable(value: string | undefined, api: PathApi): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && api.isAbsolute(value);
}

export function resolveHome(input: JevrisPathsInput = {}): { readonly home: string; readonly source: HomeSource } {
  const platform = input.platform ?? process.platform;
  const api = pathApiFor(platform);
  const env = input.env ?? process.env;
  if (typeof input.home === 'string' && input.home.length > 0) {
    return { home: api.resolve(input.home), source: 'explicit' };
  }
  const fromEnv = envValue(env, 'JEVRIS_HOME', platform);
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && !fromEnv.includes('\0')) {
    return { home: api.resolve(fromEnv), source: 'JEVRIS_HOME' };
  }
  return { home: api.resolve(input.osHome ?? homedir()), source: 'os' };
}

export function jevrisPaths(input: JevrisPathsInput = {}): JevrisPaths {
  const platform = input.platform ?? process.platform;
  const api = pathApiFor(platform);
  const env = input.env ?? process.env;
  const { home, source } = resolveHome(input);
  const osVars = source === 'os';
  const fromEnv = (name: string): string | undefined => {
    if (!osVars) return undefined;
    const value = envValue(env, name, platform);
    return usable(value, api) ? value : undefined;
  };
  const legacyConfig = api.join(home, '.config', 'jevris');
  const legacyData = api.join(home, '.jevris');

  if (platform === 'win32') {
    const roaming = fromEnv('APPDATA') ?? api.join(home, 'AppData', 'Roaming');
    const local = fromEnv('LOCALAPPDATA') ?? api.join(home, 'AppData', 'Local');
    const data = api.join(local, 'Jevris');
    return {
      platform,
      home,
      homeSource: source,
      config: api.join(roaming, 'Jevris'),
      data,
      state: api.join(data, 'state'),
      runtime: api.join(data, 'run'),
      legacyConfig,
      legacyData,
    };
  }

  if (platform === 'darwin') {
    return {
      platform,
      home,
      homeSource: source,
      config: legacyConfig,
      data: legacyData,
      state: legacyData,
      runtime: api.join(legacyData, 'run'),
      legacyConfig,
      legacyData,
    };
  }

  // linux and every other POSIX host follow the XDG base-directory layout.
  const configHome = fromEnv('XDG_CONFIG_HOME') ?? api.join(home, '.config');
  const dataHome = fromEnv('XDG_DATA_HOME') ?? api.join(home, '.local', 'share');
  const stateHome = fromEnv('XDG_STATE_HOME') ?? api.join(home, '.local', 'state');
  const state = api.join(stateHome, 'jevris');
  return {
    platform,
    home,
    homeSource: source,
    config: api.join(configHome, 'jevris'),
    data: api.join(dataHome, 'jevris'),
    state,
    runtime: api.join(state, 'run'),
    legacyConfig,
    legacyData,
  };
}

/** Every distinct Jevris root, deepest first, for removal and doctor. */
export function jevrisRoots(paths: JevrisPaths): readonly string[] {
  const api = pathApiFor(paths.platform);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [paths.runtime, paths.state, paths.data, paths.config]) {
    const key = api.normalize(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.sort((left, right) => right.length - left.length);
}

/** Well-known files, so no caller spells a Jevris file name under the wrong root. */
export function installReceiptPath(paths: JevrisPaths): string {
  return pathApiFor(paths.platform).join(paths.data, 'install-receipt.json');
}

export function packsDir(paths: JevrisPaths): string {
  return pathApiFor(paths.platform).join(paths.data, 'packs');
}

export function calibrationReleasePath(paths: JevrisPaths): string {
  return pathApiFor(paths.platform).join(paths.config, 'calibration-release.json');
}

/**
 * True for a path inside a Jevris packs directory under any layout or OS: `.jevris/packs`
 * (darwin and legacy), `jevris/packs` (XDG) and `Jevris\packs` (Windows). Writers that must
 * never touch installed packs refuse these paths.
 */
export function isPacksPath(path: string): boolean {
  const parts = path.split(/[\\/]+/);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const dir = (parts[i] ?? '').toLowerCase();
    if ((dir === '.jevris' || dir === 'jevris') && (parts[i + 1] ?? '').toLowerCase() === 'packs') return true;
  }
  return false;
}
