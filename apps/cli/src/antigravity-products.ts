/**
 * Which Antigravity products are on this host (AGY-01, AGY-05, ADM-05). The harness id stays
 * `antigravity` (launcher name `agy`); the binaries differ per product:
 *
 * - Antigravity CLI: `agy`, on PATH or where its installer puts it (~/.local/bin on macOS and
 *   Linux, %LOCALAPPDATA%\agy\bin on Windows; antigravity.google/docs/cli/install). It is the only
 *   product with a headless interface (`agy plugin list`, headless runs), so certify needs it.
 * - Antigravity 2.0 (the app, bundle id com.google.antigravity) and the Antigravity IDE (bundle id
 *   com.google.antigravity-ide, whose `antigravity-ide` launcher is a VS Code style CLI for the
 *   editor, not for the agent). Both load plugins only inside their GUI.
 *
 * All three load plugins, hooks, MCP servers and skills from the same global customization
 * root, `~/.gemini/config/plugins/<name>/` (antigravity.google/docs/plugins), which is where
 * `jevris install` writes the Jevris plugin. The app and IDE locations are known only on macOS
 * (/Applications or ~/Applications); the docs give no Windows or Linux location for them, so
 * nothing is guessed there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { liveHarnessAllowed } from './live-harness.js';

export interface AntigravityApp {
  readonly product: 'app' | 'ide';
  readonly name: string;
  readonly path: string;
  readonly bundleId: string | null;
  readonly version: string | null;
  /** The IDE's editor CLI (`antigravity-ide`), when present. */
  readonly cli: string | null;
}

export interface AntigravityProducts {
  readonly app: AntigravityApp | null;
  readonly ide: AntigravityApp | null;
}

const BUNDLES: readonly { readonly product: 'app' | 'ide'; readonly name: string; readonly bundle: string; readonly cli: string | null }[] = [
  { product: 'app', name: 'Antigravity app', bundle: 'Antigravity.app', cli: null },
  { product: 'ide', name: 'Antigravity IDE', bundle: 'Antigravity IDE.app', cli: join('Contents', 'Resources', 'app', 'bin', 'antigravity-ide') },
];

function plistString(xml: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]{1,200})</string>`).exec(xml);
  return match?.[1]?.trim() ?? null;
}

/**
 * The machine-wide folder the app and IDE bundles are looked for in. A test run (JEVRIS_TEST, a
 * node test context or JEVRIS_NO_LIVE_HARNESS) never reads it, so the result does not depend on
 * which Antigravity happens to be installed here; only the injected folders and the (temporary)
 * home's Applications are read. JEVRIS_LIVE_HARNESS=1 lifts that for a live smoke. This is the
 * only place the CLI names /Applications (lint/isolation.lint.mjs).
 */
export function systemApplicationDirs(env: { readonly [key: string]: string | undefined } = process.env): readonly string[] {
  return liveHarnessAllowed(env) ? ['/Applications'] : [];
}

/** The Antigravity app and IDE bundles (macOS only; elsewhere both are null). */
export function antigravityProducts(
  input: {
    readonly platform?: string;
    readonly home?: string;
    readonly applicationDirs?: readonly string[];
    readonly env?: { readonly [key: string]: string | undefined };
  } = {},
): AntigravityProducts {
  const platform = input.platform ?? process.platform;
  if (platform !== 'darwin' && input.applicationDirs === undefined) return { app: null, ide: null };
  // Tests stay hermetic: in a test run only the (temporary) home's Applications is read.
  const dirs = input.applicationDirs ?? [...systemApplicationDirs(input.env ?? process.env), ...(input.home === undefined ? [] : [join(input.home, 'Applications')])];
  const find = (spec: (typeof BUNDLES)[number]): AntigravityApp | null => {
    for (const dir of dirs) {
      const path = join(dir, spec.bundle);
      const plist = join(path, 'Contents', 'Info.plist');
      if (!existsSync(plist)) continue;
      let xml = '';
      try {
        xml = readFileSync(plist, 'utf8').slice(0, 65_536);
      } catch {
        xml = '';
      }
      const cli = spec.cli === null ? null : join(path, spec.cli);
      return {
        product: spec.product,
        name: spec.name,
        path,
        bundleId: plistString(xml, 'CFBundleIdentifier'),
        version: plistString(xml, 'CFBundleShortVersionString'),
        cli: cli !== null && existsSync(cli) ? cli : null,
      };
    }
    return null;
  };
  const [app, ide] = BUNDLES.map(find);
  return { app: app ?? null, ide: ide ?? null };
}

/** Doctor's line naming each Antigravity product and where Jevris is loaded from. */
/** What doctor knows about the Antigravity CLI: found, its version, and whether a signed record covers it here. */
export interface AntigravityCliStatus {
  readonly found: boolean;
  readonly version: string | null;
  readonly certified: boolean;
  /** The version range the covering record certifies, when there is one. */
  readonly range?: string;
}

export function antigravityProductsLine(products: AntigravityProducts, cli: AntigravityCliStatus): string {
  const part = (item: AntigravityApp | null, name: string) => (item === null ? `${name} not found` : `${name} ${item.version ?? 'unknown version'} (GUI only)`);
  const agy = !cli.found
    ? 'Antigravity CLI (agy) not found'
    : `Antigravity CLI (agy) ${cli.version ?? 'found'}, ${cli.certified ? `certified for ${cli.range ?? cli.version ?? 'its version'}` : 'not certified on this host'}`;
  return [
    `harness antigravity products: ${agy}`,
    part(products.app, 'Antigravity app'),
    part(products.ide, 'Antigravity IDE'),
    'all three load ~/.gemini/config/plugins/jevris; certify needs the CLI, because the app and IDE load plugins only in their GUI',
  ].join('; ');
}

/** Why certify cannot run for Antigravity without the CLI, and what to do. */
export function antigravityCertifyHint(products: AntigravityProducts): string {
  const present = [products.app, products.ide].filter((item): item is AntigravityApp => item !== null).map((item) => item.name);
  const which = present.length === 0 ? '' : ` The ${present.join(' and ')} ${present.length === 1 ? 'is' : 'are'} installed, but ${present.length === 1 ? 'it loads' : 'they load'} plugins only in the GUI, so they cannot be certified headlessly.`;
  return `agy (the Antigravity CLI) is not on PATH or in its install folder; install it with the official installer (antigravity.google/docs/cli/install) to certify Antigravity.${which}`;
}
