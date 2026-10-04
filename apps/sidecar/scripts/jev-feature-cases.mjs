/**
 * The capability cases of the Jev feature suite, one module per part (`jev-feature-cases-a.mjs` to
 * `-c.mjs`). Each part runs in a sandbox of its own, because the parts set up different workspaces and
 * approved checks and some cases change them: a fresh home, a fresh workspace made from the part's
 * `FILES`, `preparePart` for what is not an op (the host policy, approved checks), a fresh sidecar, and
 * `wrapSidecar` for the part's own setup pseudo-ops.
 */
const PART_IDS = ['a', 'b', 'c'];

export const PARTS = await Promise.all(
  PART_IDS.map(async (id) => {
    const mod = await import(`./jev-feature-cases-${id}.mjs`);
    return {
      id,
      CASES: mod.CASES ?? [],
      FILES: mod.FILES ?? {},
      KNOWN_LEAKS: mod.KNOWN_LEAKS ?? {},
      KNOWN_DEFECTS: mod.KNOWN_DEFECTS ?? {},
      preparePart: typeof mod.preparePart === 'function' ? mod.preparePart : async () => undefined,
      wrapSidecar: typeof mod.wrapSidecar === 'function' ? mod.wrapSidecar : (sidecar) => sidecar,
    };
  }),
);

export const CASES = PARTS.flatMap((p) => p.CASES);
