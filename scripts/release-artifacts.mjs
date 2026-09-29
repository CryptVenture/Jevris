/**
 * Release artifacts generated from the bundle manifest and the lockfile (PKG-10):
 *
 * - dist/THIRD_PARTY_NOTICES.md: every bundled third-party module with its licence text,
 *   and every runtime dependency (installed next to the package, not bundled).
 * - dist/sbom.cdx.json: a CycloneDX 1.5 SBOM of the published package: bundled modules and
 *   the runtime dependency closure from package-lock.json, with purls, licences and hashes.
 *
 * Both are deterministic for a given tree (no timestamps unless SOURCE_DATE_EPOCH is set),
 * so a rebuild of the same commit gives the same bytes.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function purl(name, version) {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${version}`;
}

function lockEntry(lock, from, name) {
  // Node resolution inside the lockfile: nearest node_modules walking up from `from`.
  let base = from;
  for (;;) {
    const key = base.length === 0 ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (lock.packages[key] !== undefined) return { key, entry: lock.packages[key] };
    if (base.length === 0) return undefined;
    const at = base.lastIndexOf('/node_modules/');
    base = at < 0 ? '' : base.slice(0, at);
  }
}

/**
 * The runtime dependency closure of the root package from package-lock.json. Optional
 * dependencies (per-platform native packages) are included and flagged.
 */
export function runtimeClosure(lock, rootDeps) {
  const found = new Map();
  const queue = Object.keys(rootDeps).map((name) => ({ from: '', name, optional: false }));
  while (queue.length > 0) {
    const { from, name, optional } = queue.shift();
    const hit = lockEntry(lock, from, name);
    if (hit === undefined) {
      if (optional) continue;
      throw new Error(`lockfile has no entry for runtime dependency ${name}`);
    }
    if (found.has(hit.key)) continue;
    const entry = hit.entry;
    found.set(hit.key, {
      name,
      version: entry.version,
      license: typeof entry.license === 'string' ? entry.license : 'UNKNOWN',
      integrity: entry.integrity,
      optional: optional || entry.optional === true,
      platform: Array.isArray(entry.os) || Array.isArray(entry.cpu) ? { os: entry.os ?? [], cpu: entry.cpu ?? [] } : undefined,
    });
    for (const dep of Object.keys(entry.dependencies ?? {})) queue.push({ from: hit.key, name: dep, optional: false });
    for (const dep of Object.keys(entry.optionalDependencies ?? {})) queue.push({ from: hit.key, name: dep, optional: true });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function integrityHash(integrity) {
  if (typeof integrity !== 'string') return [];
  const [alg, b64] = integrity.split('-');
  if (alg !== 'sha512' || b64 === undefined) return [];
  return [{ alg: 'SHA-512', content: Buffer.from(b64, 'base64').toString('hex') }];
}

function licenseChoice(license) {
  if (license === 'UNKNOWN') return [];
  if (/^[A-Za-z0-9.+-]+$/.test(license)) return [{ license: { id: license } }];
  return [{ expression: license }];
}

export function buildSbom({ pkg, bundled, runtime, outputs }) {
  const timestamp = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : undefined;
  const rootRef = purl(pkg.name, pkg.version);
  const components = [];
  for (const item of bundled) {
    components.push({
      type: 'library',
      'bom-ref': purl(item.name, item.version),
      name: item.name,
      version: item.version,
      purl: purl(item.name, item.version),
      licenses: licenseChoice(item.license),
      properties: [{ name: 'jevris:inclusion', value: 'bundled' }],
    });
  }
  for (const item of runtime) {
    components.push({
      type: 'library',
      'bom-ref': purl(item.name, item.version),
      name: item.name,
      version: item.version,
      purl: purl(item.name, item.version),
      licenses: licenseChoice(item.license),
      hashes: integrityHash(item.integrity),
      scope: item.optional ? 'optional' : 'required',
      properties: [{ name: 'jevris:inclusion', value: 'runtime-dependency' }],
    });
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuidFrom(`${pkg.name}@${pkg.version}:${JSON.stringify(components)}`)}`,
    version: 1,
    metadata: {
      ...(timestamp === undefined ? {} : { timestamp }),
      tools: { components: [{ type: 'application', name: 'jevris-release-artifacts', version: pkg.version }] },
      component: {
        type: 'application',
        'bom-ref': rootRef,
        name: pkg.name,
        version: pkg.version,
        purl: rootRef,
        licenses: licenseChoice(pkg.license ?? 'UNKNOWN'),
        hashes: [],
        properties: outputs.map((item) => ({ name: `jevris:file:${item.path}`, value: `sha256:${item.sha256}` })),
      },
    },
    components,
    dependencies: [{ ref: rootRef, dependsOn: components.map((item) => item['bom-ref']) }],
  };
}

/** A deterministic RFC 4122 v5-shaped UUID from text (no randomness in a release artifact). */
export function uuidFrom(text) {
  const hex = createHash('sha1').update(text).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export function buildNotices({ pkg, bundled, runtime }) {
  const lines = [
    `# Third-party notices for ${pkg.name} ${pkg.version}`,
    '',
    'This package bundles the modules in part 1 into its dist/ files. The packages in part 2',
    'are installed next to it by npm as runtime dependencies and keep their own licence files.',
    '',
    '## Part 1: bundled modules',
    '',
  ];
  for (const item of bundled) {
    lines.push(`### ${item.name} ${item.version} (${item.license})`, '');
    if (typeof item.repository === 'string') lines.push(`Source: ${item.repository}`, '');
    const text = (item.licenseText ?? '').trim();
    lines.push(text.length > 0 ? ['```text', text, '```'].join('\n') : `Licence: ${item.license}. No licence file shipped in the package.`, '');
  }
  lines.push('## Part 2: runtime dependencies', '', '| Package | Version | Licence | Optional |', '| --- | --- | --- | --- |');
  for (const item of runtime) lines.push(`| ${item.name} | ${item.version} | ${item.license} | ${item.optional ? 'yes (per-platform)' : 'no'} |`);
  lines.push('');
  return lines.join('\n');
}

export function readLock(root) {
  return JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
}
