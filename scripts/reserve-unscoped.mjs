#!/usr/bin/env node
/**
 * The unscoped `jevris` npm name (PKG-14, E-38). Jevris publishes only as @webventures/jevris.
 * This builds a placeholder `jevris` package whose bin tells the user the right command and exits
 * non-zero, so an old `npx jevris` instruction cannot run someone else's code.
 *
 *   node scripts/reserve-unscoped.mjs                 # build it and `npm pack --dry-run` it
 *   node scripts/reserve-unscoped.mjs --out <dir>     # keep the placeholder in <dir>
 *   node scripts/reserve-unscoped.mjs --publish       # owner only: npm publish (npm 2FA)
 *
 * If the name is already taken by someone else, the docs keep stating that the unscoped name is
 * not Jevris (docs/installation.md).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMain } from './build.mjs';
import { npmCli } from './pack-smoke.mjs';
import { PACKAGE_NAME } from './release-policy.mjs';

export const PLACEHOLDER_VERSION = '0.0.1';

export function placeholderFiles() {
  const message = `The unscoped "jevris" package is a placeholder. Jevris is published as ${PACKAGE_NAME}:\\n  npx ${PACKAGE_NAME} --help\\n`;
  return {
    'package.json': `${JSON.stringify(
      {
        name: 'jevris',
        version: PLACEHOLDER_VERSION,
        description: `Placeholder. Jevris is published as ${PACKAGE_NAME}.`,
        license: 'MIT',
        homepage: 'https://github.com/CryptVenture/Jevris#readme',
        repository: { type: 'git', url: 'git+https://github.com/CryptVenture/Jevris.git' },
        bin: { jevris: './index.js' },
        files: ['index.js', 'README.md'],
        publishConfig: { access: 'public' },
      },
      null,
      2,
    )}\n`,
    'index.js': `#!/usr/bin/env node\nprocess.stderr.write("${message}");\nprocess.exit(1);\n`,
    'README.md': `# jevris (placeholder)\n\nThis name is reserved so it cannot be taken by another package. Jevris is published as\n[\`${PACKAGE_NAME}\`](https://www.npmjs.com/package/${PACKAGE_NAME}):\n\n\`\`\`sh\nnpx ${PACKAGE_NAME} --help\n\`\`\`\n`,
  };
}

function main(argv) {
  const publish = argv.includes('--publish');
  const outIndex = argv.indexOf('--out');
  const keep = outIndex >= 0;
  const dir = keep ? argv[outIndex + 1] : mkdtempSync(join(tmpdir(), 'jevris-unscoped-'));
  mkdirSync(dir, { recursive: true });
  try {
    for (const [name, text] of Object.entries(placeholderFiles())) writeFileSync(join(dir, name), text);
    const args = publish ? ['publish', '--access', 'public'] : ['pack', '--dry-run'];
    const result = spawnSync(process.execPath, [npmCli(), ...args], { cwd: dir, stdio: 'inherit', shell: false, windowsHide: true });
    if (!publish) console.log('reserve-unscoped: placeholder packs cleanly. The owner reserves the name with --publish.');
    return result.status === 0 ? 0 : 1;
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
