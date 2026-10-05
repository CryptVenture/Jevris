/**
 * The hot-path measurement of the Jev feature suite: the ops a hook or a CLI call waits for, through a
 * real sidecar process, at the product's real budgets (a 900 ms hot-path request, Jev waited for at
 * most 700 ms of it), cold (the decision cache cannot answer) and cached.
 *
 * Measured here, through the sidecar's socket: `route` (a task described by structured features gets
 * its slice classified) and `plan` (a plan's tasks get slice labels). A burst of concurrent `route`
 * requests shows whether parallel Jev calls really run in parallel. A sequence of route requests over
 * a small pool of task shapes shows the cache hit rate a session would see.
 *
 * Not through the socket, and why: the check ranking runs on the Stop hook (it needs a certified
 * harness hook and an approved check set) and the repeated-failure advice runs detached after a hook
 * has answered. `measureEngineHot` runs their real deciders in this process on the real engine with the
 * production waits, so their cold and cached times are measured the same way, without the IPC.
 *
 * Everything recorded is numbers and codes: elapsed times, the op's own reason codes, whether the
 * answer came from Jev, the rules or the cache. Never a key, a request or a response body.
 */

/** The product's hot-path request budget and the Jev wait inside it (`SLICE_DEADLINE_MS`). */
export const HOT_BUDGET_MS = 900;
export const JEV_WAIT_MS = 700;

/** A seeded generator, so a run's task shapes are the same every time. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const VERB_TITLES = [
  ['fix', 'Fix the intermittent failure in the'],
  ['add', 'Add a new option to the'],
  ['refactor', 'Refactor the shared helpers of the'],
  ['review', 'Review the recent changes to the'],
  ['research', 'Investigate how to speed up the'],
  ['debug', 'Debug the crash that happens in the'],
];
const AREAS = ['billing module', 'settings page', 'search index', 'export job', 'sync worker', 'login flow', 'report builder', 'cache layer', 'import tool', 'notification queue'];
const SOURCE_EXT = ['ts', 'tsx', 'js', 'py', 'go', 'rs'];
const CHECK_SETS = [[], ['unit-tests'], ['unit-tests', 'lint'], ['unit-tests', 'typecheck', 'build'], ['lint']];

/**
 * `count` task descriptions whose structured features all differ (so each one is a decision-cache miss
 * the first time) and none of which the rules settle alone (each has a source file and a verb that is
 * not `run` or `docs`, so Jev is asked).
 */
export function distinctTasks(count, seed = 1) {
  const random = seeded(seed);
  const seen = new Set();
  const out = [];
  let guard = 0;
  while (out.length < count && guard < 10_000) {
    guard += 1;
    const [verb, lead] = VERB_TITLES[Math.floor(random() * VERB_TITLES.length)];
    const area = AREAS[Math.floor(random() * AREAS.length)];
    const sourceFiles = 1 + Math.floor(random() * 5);
    const testFiles = Math.floor(random() * 3);
    const configFiles = Math.floor(random() * 2);
    const ext = SOURCE_EXT[Math.floor(random() * SOURCE_EXT.length)];
    const checks = CHECK_SETS[Math.floor(random() * CHECK_SETS.length)];
    const padding = Math.floor(random() * 3) === 0 ? ' that the whole team depends on every single day of the working week and that nobody dares to touch' : '';
    const paths = [];
    for (let i = 0; i < sourceFiles; i += 1) paths.push(`src/${area.replace(/ /g, '-')}/part${i}.${ext}`);
    for (let i = 0; i < testFiles; i += 1) paths.push(`test/${area.replace(/ /g, '-')}/part${i}.test.${ext}`);
    for (let i = 0; i < configFiles; i += 1) paths.push(`config/${area.replace(/ /g, '-')}${i}.json`);
    const title = `${lead} ${area}${padding}`;
    // The features the classifier sends; a shape seen before would be a cache hit, so it is not repeated.
    const key = JSON.stringify([verb, sourceFiles, testFiles, configFiles, ext, checks, padding.length > 0]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, title, paths, checkIds: checks });
  }
  return out;
}

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]);
  return { n: sorted.length, min: at(0), p50: at(50), p95: at(95), p99: at(99), max: at(100) };
}

/** The fraction of `values` at or under each wait, to three places. */
export function fitFractions(values, waits) {
  const out = {};
  for (const wait of waits) out[String(wait)] = values.length === 0 ? null : Math.round((values.filter((v) => v <= wait).length / values.length) * 1000) / 1000;
  return out;
}

function summarize(rows) {
  const answered = rows.filter((r) => r.ok);
  const times = rows.map((r) => r.elapsedMs);
  const fromJev = rows.filter((r) => r.source === 'jev').length;
  return {
    n: rows.length,
    answered: answered.length,
    clientTimeouts: rows.filter((r) => !r.ok).length,
    elapsedMs: distribution(times),
    withinBudget: fitFractions(times.filter((_, i) => rows[i].ok), [HOT_BUDGET_MS]),
    fromJev,
    fromRules: rows.filter((r) => r.source === 'rules' || r.source === 'none').length,
    cacheHits: rows.filter((r) => r.cacheHit === true).length,
    abandoned: rows.filter((r) => r.abandoned === true).length,
    reasonCounts: rows.reduce((acc, r) => ({ ...acc, [r.reasonCode ?? 'none']: (acc[r.reasonCode ?? 'none'] ?? 0) + 1 }), {}),
    sliceLatencyMs: distribution(rows.map((r) => r.sliceLatencyMs).filter((v) => typeof v === 'number')),
  };
}

function routeBody(task) {
  return { currentModel: 'claude-opus-5', modelPin: null, effortPin: null, taskId: null, sliceId: null, task: { title: task.title, paths: task.paths, checkIds: task.checkIds } };
}

/**
 * A refused or failed op in the record by code, never as a message: its reason code, else its short `reason` word upper-cased (`unavailable` is
 * `UNAVAILABLE`), else `FAILED`. The record is numbers and codes only (features-record.ts), and a free-text reason would refuse the write.
 */
function failureCode(res) {
  for (const candidate of [res.reasonCode, res.reason]) if (typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(candidate)) return candidate.toUpperCase();
  return 'FAILED';
}

async function routeOnce(sidecar, { home, work }, task, phase, i) {
  const started = performance.now();
  const res = await sidecar.sidecarRequest({ home, op: 'route', scope: 'cli', workspace: work, body: routeBody(task), budget: 'hot', timeoutMs: HOT_BUDGET_MS });
  const elapsedMs = Math.round(performance.now() - started);
  const slice = res.ok ? res.result?.slice : undefined;
  const reasonCode = res.ok ? (slice?.reasonCode ?? 'NO_SLICE') : failureCode(res);
  return {
    op: 'route',
    phase,
    i,
    ok: res.ok,
    elapsedMs,
    reasonCode,
    source: slice === undefined ? 'none' : slice.source,
    asked: slice?.asked === true,
    cacheHit: slice?.cacheHit ?? null,
    sliceLatencyMs: typeof slice?.latencyMs === 'number' ? slice.latencyMs : null,
    abandoned: /DEADLINE/.test(reasonCode),
    decisionId: slice?.decisionId ?? null,
  };
}

function taskNode(id, title, scopes, checks) {
  return { id, title, schemaVersion: '1.0', workspaceId: 'jev-hot-ws', revision: 'r1', state: 'proposed', requirementIds: ['R1'], dependencyIds: [], writeScopes: scopes, acceptanceCheckIds: checks.length === 0 ? ['unit-tests'] : checks, rootBudgetId: 'root-budget' };
}

async function planOnce(sidecar, { home, work }, tasks, phase, i) {
  const nodes = [taskNode(`P${i}A`, 'Update the install guide', ['docs/installation.md'], ['lint-docs']), ...tasks.map((t, k) => taskNode(`P${i}${'BCDE'[k]}`, t.title, t.paths, t.checkIds))];
  const started = performance.now();
  const res = await sidecar.sidecarRequest({ home, op: 'plan', scope: 'cli', workspace: work, body: { tasks: nodes }, budget: 'hot', timeoutMs: HOT_BUDGET_MS });
  const elapsedMs = Math.round(performance.now() - started);
  const list = res.ok && Array.isArray(res.result?.sliceSuggestions) ? res.result.sliceSuggestions : [];
  const reasons = list.map((s) => s.reasonCode);
  const fromJev = list.filter((s) => s.source === 'jev').length;
  return {
    op: 'plan',
    phase,
    i,
    ok: res.ok,
    elapsedMs,
    reasonCode: res.ok ? (reasons.find((c) => /DEADLINE|CAP|NO_TIME/.test(c)) ?? reasons.find((c) => c.startsWith('SLICE_JEV')) ?? reasons[0] ?? 'NO_SUGGESTIONS') : failureCode(res),
    source: fromJev > 0 ? 'jev' : 'rules',
    asked: list.some((s) => s.confidencePercent !== null),
    cacheHit: null,
    abandoned: reasons.some((c) => /DEADLINE/.test(c)),
    labelled: list.length,
    jevLabels: fromJev,
    sliceLatencyMs: null,
  };
}

/**
 * Runs the sidecar-level hot-path measurement. `cold` distinct requests per op, then the same ones again
 * for the cached phase, one at a time; a concurrent burst; and a realistic repeat sequence. `warm` first
 * sends one unmeasured route request so the sidecar's first-call setup (connection, registry) is not
 * counted against the first sample: the first request of a process is recorded separately.
 */
export async function runSidecarHotPath({ sidecar, home, work, cold = 30, burst = 3, sequence = 100, progress = () => undefined }) {
  const ctx = { home, work };
  const routeTasks = distinctTasks(cold + burst * 4 + 8, 11);
  const out = { budgetMs: HOT_BUDGET_MS, jevWaitMs: JEV_WAIT_MS };

  // The first request this sidecar ever serves: connection setup and the first journal writes included.
  const firstTask = routeTasks.pop();
  out.firstRequest = await routeOnce(sidecar, ctx, firstTask, 'first', 0);
  progress(`route first request: ${out.firstRequest.elapsedMs} ms (${out.firstRequest.reasonCode})`);

  const coldTasks = routeTasks.splice(0, cold);
  const routeCold = [];
  for (let i = 0; i < coldTasks.length; i += 1) routeCold.push(await routeOnce(sidecar, ctx, coldTasks[i], 'cold', i));
  const routeCached = [];
  for (let i = 0; i < coldTasks.length; i += 1) routeCached.push(await routeOnce(sidecar, ctx, coldTasks[i], 'cached', i));
  out.route = { cold: summarize(routeCold), cached: summarize(routeCached), rowsCold: routeCold, rowsCached: routeCached };
  progress(`route cold p50=${out.route.cold.elapsedMs.p50} p95=${out.route.cold.elapsedMs.p95} abandoned=${out.route.cold.abandoned}; cached p50=${out.route.cached.elapsedMs.p50}`);

  // Plans: one task the rules settle (docs) and two Jev is asked about, every plan new.
  const planTasks = distinctTasks(cold * 2 + 4, 23);
  const planCold = [];
  for (let i = 0; i < cold; i += 1) planCold.push(await planOnce(sidecar, ctx, [planTasks[i * 2], planTasks[i * 2 + 1]], 'cold', i));
  const planCached = [];
  for (let i = 0; i < cold; i += 1) planCached.push(await planOnce(sidecar, ctx, [planTasks[i * 2], planTasks[i * 2 + 1]], 'cached', i));
  out.plan = { cold: summarize(planCold), cached: summarize(planCached), rowsCold: planCold, rowsCached: planCached };
  progress(`plan cold p50=${out.plan.cold.elapsedMs.p50} p95=${out.plan.cold.elapsedMs.p95} abandoned=${out.plan.cold.abandoned}; cached p50=${out.plan.cached.elapsedMs.p50}`);

  // Bursts: four concurrent route requests whose features differ. If Jev calls ran one at a time the
  // last of each burst would take about four times as long as the first.
  const bursts = [];
  for (let b = 0; b < burst; b += 1) {
    const four = routeTasks.splice(0, 4);
    const rows = await Promise.all(four.map((task, k) => routeOnce(sidecar, ctx, task, 'burst', b * 4 + k)));
    bursts.push(rows);
  }
  const burstRows = bursts.flat();
  const spread = bursts.map((rows) => {
    const times = rows.map((r) => r.elapsedMs).sort((a, c) => a - c);
    return { fastest: times[0], slowest: times[times.length - 1] };
  });
  out.burst = { size: 4, bursts: burst, summary: summarize(burstRows), spread, rows: burstRows };
  progress(`burst x4: p50=${out.burst.summary.elapsedMs.p50} p95=${out.burst.summary.elapsedMs.p95} abandoned=${out.burst.summary.abandoned}`);

  // The repeat sequence: a session asks about a few task shapes again and again.
  const pool = distinctTasks(12, 97);
  const random = seeded(5);
  const seq = [];
  for (let i = 0; i < sequence; i += 1) {
    // A skewed draw: low indexes are asked far more often, as a person's recurring kinds of task are.
    const k = Math.min(pool.length - 1, Math.floor(Math.pow(random(), 2) * pool.length));
    seq.push(await routeOnce(sidecar, ctx, pool[k], 'sequence', i));
  }
  const hits = seq.filter((r) => r.cacheHit === true).length;
  out.sequence = { requests: seq.length, distinctShapes: pool.length, cacheHits: hits, cacheHitRate: seq.length === 0 ? null : Math.round((hits / seq.length) * 1000) / 1000, jevRequestsMade: seq.length - hits, summary: summarize(seq) };
  progress(`sequence of ${seq.length}: cache hits ${hits} (${out.sequence.cacheHitRate})`);
  return out;
}

/**
 * The deciders that do not run on a socket the hot path measures, run in this process on the real
 * engine at the production waits. `deciders` are `{ id, run(engine, i) }`; each runs `cold` times on a
 * fresh engine per run (no cache), then `cold` times on one engine (cache). Returns, per decider, the
 * distributions and what fraction of cold runs fit the waits the product allows.
 */
export async function measureEngineHot({ deciders, createEngine, cold = 30, waits = [350, 450, 700, 900, 1500], progress = () => undefined }) {
  const out = {};
  for (const d of deciders) {
    // One engine for both phases: every cold run asks about a request this engine has not seen (the
    // runs differ), so the cache cannot answer it; the cached runs then repeat them. A cold run the
    // cache did answer (two runs that happen to share features) is left out of the cold figures.
    const engine = await createEngine();
    const coldRows = [];
    for (let i = 0; i < cold; i += 1) {
      const started = performance.now();
      const result = await d.run(engine, i);
      coldRows.push({ elapsedMs: Math.round(performance.now() - started), ...result });
    }
    const cachedRows = [];
    for (let i = 0; i < cold; i += 1) {
      const started = performance.now();
      const result = await d.run(engine, i);
      cachedRows.push({ elapsedMs: Math.round(performance.now() - started), ...result });
    }
    const trueCold = coldRows.filter((r) => r.cacheHit !== true);
    const coldTimes = trueCold.map((r) => r.elapsedMs);
    out[d.id] = {
      cold: distribution(coldTimes),
      cached: distribution(cachedRows.map((r) => r.elapsedMs)),
      coldFitsWait: fitFractions(coldTimes, waits),
      cachedFitsWait: fitFractions(cachedRows.map((r) => r.elapsedMs), waits),
      coldRunsAnsweredByCache: coldRows.length - trueCold.length,
      fromJev: trueCold.filter((r) => r.source === 'jev').length,
      deadlineFallbacks: trueCold.filter((r) => /DEADLINE/.test(r.reasonCode ?? '')).length,
      cacheHits: cachedRows.filter((r) => r.cacheHit === true).length,
      reasonCounts: trueCold.reduce((acc, r) => ({ ...acc, [r.reasonCode ?? 'none']: (acc[r.reasonCode ?? 'none'] ?? 0) + 1 }), {}),
    };
    progress(`${d.id}: cold p50=${out[d.id].cold.p50} p95=${out[d.id].cold.p95}; cached p50=${out[d.id].cached.p50}`);
  }
  return out;
}
