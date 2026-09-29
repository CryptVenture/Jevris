/**
 * The one Kilo and OpenCode plugin template (plugins/shared/shim.js) and the renderer that
 * turns it into either harness's plugin file (DRY: one tracked copy, rendered at install).
 *
 * The template differs from a rendered plugin only in three placeholder lines: the harness
 * id, the launcher name and the export form, all read from the harness's own manifest
 * (plugins/kilocode/harness.json, plugins/opencode/harness.json). Each is replaced exactly
 * once, or rendering refuses. The install-time runtime line (`const JEVRIS_RUNTIME = null;`)
 * is left alone; the installer substitutes it afterwards.
 */

export type ShimHarness = 'kilocode' | 'opencode';

export const SHIM_PLACEHOLDERS = {
  harness: "const HARNESS_ID = '@JEVRIS_HARNESS_ID@';",
  launcher: "const LAUNCHER_NAME = '@JEVRIS_LAUNCHER_NAME@';",
  exports: '// @JEVRIS_EXPORTS@',
} as const;

/** The export line each loader reads, by the manifest's `plugin.export` form. */
export const SHIM_EXPORTS = {
  // Kilo loads a PluginModule default export: { id, server }.
  default: "export default { id: 'jevris', server };",
  // OpenCode calls every exported function of a plugin file, so this file exports one.
  named: 'export const JevrisPlugin = server;',
} as const;

/** The harness values a rendered plugin needs; they come from plugins/<harness>/harness.json. */
export interface ShimTarget {
  readonly harness: ShimHarness;
  readonly launcher: string;
  readonly exportForm: keyof typeof SHIM_EXPORTS;
}

function replaceOnce(lines: string[], from: string, to: string): boolean {
  const at = lines.flatMap((line, index) => (line === from ? [index] : []));
  if (at.length !== 1) return false;
  lines[at[0] ?? 0] = to;
  return true;
}

/** Renders one harness's plugin file, or null when the template or the target is not the expected one. */
export function renderShimPlugin(template: string, target: ShimTarget): string | null {
  if (target.harness !== 'kilocode' && target.harness !== 'opencode') return null;
  if (!/^[a-z]+$/.test(target.launcher) || !Object.hasOwn(SHIM_EXPORTS, target.exportForm)) return null;
  const lines = template.split('\n');
  const ok =
    replaceOnce(lines, SHIM_PLACEHOLDERS.harness, `const HARNESS_ID = '${target.harness}';`) &&
    replaceOnce(lines, SHIM_PLACEHOLDERS.launcher, `const LAUNCHER_NAME = '${target.launcher}';`) &&
    replaceOnce(lines, SHIM_PLACEHOLDERS.exports, SHIM_EXPORTS[target.exportForm]);
  if (!ok) return null;
  const text = lines.join('\n');
  return text.includes('@JEVRIS_') ? null : text;
}
