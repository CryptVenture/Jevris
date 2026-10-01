// Sonnet-first routing where people look (owner decision 2026-09-30, visibility): the exact plain
// text of the three outputs, from the views the orchestrator computes. The wording is stable (the
// docs name it), money is integer micro-USD, a figure without data reads "unknown" or "not
// measured yet", and no line claims quality. Pure: no sidecar, no ledger, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';

const { firstTryCostLines, firstTrySliceLines, firstTryStatusLine } = await import('../dist/first-try-lines.js');

const ZERO = { firstTry: 0, baselineFirst: 0, learning: 0 };
const harness = (over) => ({ harness: 'claude', state: 'on', reasonCode: null, baselineModelId: 'claude-opus-5-5', firstTryModelId: 'claude-sonnet-5-5', strongerIsPreview: false, slices: ZERO, ...over });
const CLAUDE = harness({});
const CODEX = harness({ harness: 'codex', baselineModelId: 'gpt-6.1-sol', firstTryModelId: 'gpt-6-luna' });
const ANTIGRAVITY = harness({ harness: 'antigravity', state: 'off', reasonCode: 'NO_CHEAPER_RUNG', baselineModelId: 'gemini-3.8-flash', firstTryModelId: null, strongerIsPreview: true });
const status = (over = {}) => ({ setting: 'auto', unavailable: null, harnesses: [CLAUDE, CODEX, ANTIGRAVITY], other: ZERO, ...over });

const statusTable = [
  [
    'auto with no data: the ladder per harness, and Antigravity off with why',
    status(),
    'first-try slices: claude: claude-sonnet-5-5 first, claude-opus-5-5 baseline, no slices yet; codex: gpt-6-luna first, gpt-6.1-sol baseline, no slices yet; antigravity: off (no cheaper active model than gemini-3.8-flash, and its only stronger model is a preview, which is never started automatically)',
  ],
  [
    'auto with slices in each verdict',
    status({ harnesses: [harness({ slices: { firstTry: 2, baselineFirst: 1, learning: 3 } }), ANTIGRAVITY] }),
    'first-try slices: claude: claude-sonnet-5-5 first, claude-opus-5-5 baseline, 2 on the first try, 1 on the baseline, 3 still learning; antigravity: off (no cheaper active model than gemini-3.8-flash, and its only stronger model is a preview, which is never started automatically)',
  ],
  ['setting baseline: off, whatever the ledger holds', status({ setting: 'baseline', harnesses: [harness({ state: 'off', reasonCode: 'FIRST_TRY_OFF', slices: { firstTry: 4, baselineFirst: 0, learning: 0 } })] }), 'first-try slices: off (routing.firstTry is baseline, so the baseline model runs first)'],
  [
    'slices whose baseline is no harness default are counted apart',
    status({ harnesses: [CLAUDE], other: { firstTry: 1, baselineFirst: 0, learning: 2 } }),
    'first-try slices: claude: claude-sonnet-5-5 first, claude-opus-5-5 baseline, no slices yet; other baselines: 1 on the first try, 0 on the baseline, 2 still learning',
  ],
  ['no harness has a default baseline', status({ harnesses: [] }), 'first-try slices: no harness has a default baseline in the model registry'],
  ['a refused model registry', status({ unavailable: 'MODEL_REGISTRY_INVALID', harnesses: [] }), 'first-try slices: unavailable (the model registry is refused: MODEL_REGISTRY_INVALID)'],
  [
    'a harness off because no cheaper model could pay back a hand-off',
    status({ harnesses: [harness({ state: 'off', reasonCode: 'BREAK_EVEN_TOO_HIGH', firstTryModelId: null })] }),
    'first-try slices: claude: off (no cheaper model could pay back a hand-off)',
  ],
];
for (const [name, view, expected] of statusTable) {
  test(`status line, ${name}`, () => {
    assert.equal(firstTryStatusLine(view), expected);
  });
}

const group = (over = {}) => ({
  baselineModelId: 'claude-opus-5-5',
  firstTryModelId: 'claude-sonnet-5-5',
  verdict: 'first-try',
  reasonCode: 'FIRST_TRY_WORTH_IT',
  lastChange: null,
  started: { firstTry: 6, control: 1, open: 1 },
  firstTry: { finished: 5, verified: 5, firstAttemptPass: 5, firstAttemptFail: 0, handedOff: 0 },
  control: { finished: 1, verified: 1 },
  controlShare: { observed: 1 / 7, nextTaskArm: 'control', nextTaskShare: 0.1 },
  breakEven: { value: 0.5, basis: 'estimated', overheadMicroUsd: 1000, firstAttempt: { meanMicroUsd: 20_000, samples: 5 }, stepUpAttempt: { meanMicroUsd: null, samples: 0 } },
  pBelowBreakEven: 0.015625,
  pWorseThanBaseline: null,
  costPerVerified: { firstTryMicroUsd: 20_000, controlMicroUsd: 50_000, estimate: false },
  thresholds: { demoteAbove: 0.4, reinstateBelow: 0.1, minFinishedToReinstate: 12, antiFlapFloor: 5, margin: 0.075 },
  ...over,
});
const HEAD = 'first-try routing for slice issue-fix (routing.firstTry auto):';
const QUALITY = 'quality: unknown; a verified task is a passing check, not a quality score';

const sliceTable = [
  ['no first-try task has run for the slice', { sliceId: 'issue-fix', setting: 'auto', groups: [] }, [`${HEAD} no first-try task has run for it in this workspace yet`]],
  [
    'no first-try task has run and the setting keeps the baseline first',
    { sliceId: 'issue-fix', setting: 'baseline', groups: [] },
    ['first-try routing for slice issue-fix (routing.firstTry baseline): no first-try task has run for it in this workspace, and the setting keeps the baseline model first'],
  ],
  [
    'first try: five passed',
    { sliceId: 'issue-fix', setting: 'auto', groups: [group()] },
    [
      HEAD,
      '- claude-sonnet-5-5 before claude-opus-5-5: first try (FIRST_TRY_WORTH_IT)',
      '    tasks: first try 6 started, 5 finished, 5 verified; 5 passed the check on the first attempt, 0 failed it, 0 handed up; control (baseline first) 1 started, 1 finished, 1 verified; 1 still open',
      '    control share: 1 of 7 started tasks (14%); the next task goes to the control (baseline first) with probability 10%',
      '    break-even p* = (cS + h) / (cO + h) = 0.5000 (estimated from list prices when the first task started); h = 1000 micro-USD (one verification plus the cache cost of the model change), cS = 20000 micro-USD over 5, cO = not measured yet',
      '    first-try success: P(success rate below p*) = 0.016; demote above 0.40, come back below 0.10 with at least 12 finished first-try tasks',
      '    against the control: no comparison yet, it needs 5 finished tasks in each arm',
      '    cost per verified task: first try 20000 micro-USD ($0.0200), control 50000 micro-USD ($0.0500)',
      QUALITY,
    ],
  ],
  [
    'learning: under the anti-flap floor, with no probability yet',
    {
      sliceId: 'issue-fix',
      setting: 'auto',
      groups: [
        group({
          verdict: 'learning',
          reasonCode: 'DAY_1_PRIOR',
          started: { firstTry: 1, control: 0, open: 1 },
          firstTry: { finished: 0, verified: 0, firstAttemptPass: 0, firstAttemptFail: 0, handedOff: 0 },
          control: { finished: 0, verified: 0 },
          controlShare: { observed: 0, nextTaskArm: 'control', nextTaskShare: 0.1 },
          breakEven: { value: 0.5385, basis: 'estimated', overheadMicroUsd: 200_000, firstAttempt: { meanMicroUsd: null, samples: 0 }, stepUpAttempt: { meanMicroUsd: null, samples: 0 } },
          pBelowBreakEven: null,
          costPerVerified: { firstTryMicroUsd: null, controlMicroUsd: null, estimate: false },
        }),
      ],
    },
    [
      HEAD,
      '- claude-sonnet-5-5 before claude-opus-5-5: learning (DAY_1_PRIOR)',
      '    tasks: first try 1 started, 0 finished, 0 verified; 0 passed the check on the first attempt, 0 failed it, 0 handed up; control (baseline first) 0 started, 0 finished, 0 verified; 1 still open',
      '    control share: 0 of 1 started tasks (0%); the next task goes to the control (baseline first) with probability 10%',
      '    break-even p* = (cS + h) / (cO + h) = 0.5385 (estimated from list prices when the first task started); h = 200000 micro-USD (one verification plus the cache cost of the model change), cS = not measured yet, cO = not measured yet',
      '    first-try success: no labelled first attempt yet, so no probability; the day-1 rule stands until 5 are labelled',
      '    against the control: no comparison yet, it needs 5 finished tasks in each arm',
      '    cost per verified task: not measured yet',
      QUALITY,
    ],
  ],
  [
    'baseline first after a demotion: the live verdict, the last change, the measured break-even and an estimate label',
    {
      sliceId: 'issue-fix',
      setting: 'auto',
      groups: [
        group({
          verdict: 'baseline-first',
          reasonCode: 'ANTI_FLAP',
          lastChange: { mode: 'baseline', reasonCode: 'FIRST_TRY_BELOW_BREAK_EVEN', atFinished: 5 },
          started: { firstTry: 5, control: 0, open: 0 },
          firstTry: { finished: 5, verified: 1, firstAttemptPass: 0, firstAttemptFail: 5, handedOff: 5 },
          control: { finished: 5, verified: 4 },
          controlShare: { observed: 0, nextTaskArm: 'first-try', nextTaskShare: 0.1 },
          breakEven: { value: 0.6, basis: 'measured', overheadMicroUsd: 1000, firstAttempt: { meanMicroUsd: 20_000, samples: 5 }, stepUpAttempt: { meanMicroUsd: 30_000, samples: 5 } },
          pBelowBreakEven: 0.984375,
          pWorseThanBaseline: 0.5,
          costPerVerified: { firstTryMicroUsd: 600_000, controlMicroUsd: 50_000, estimate: true },
        }),
      ],
    },
    [
      HEAD,
      '- claude-sonnet-5-5 before claude-opus-5-5: baseline first (ANTI_FLAP)',
      '    last change: to baseline first (FIRST_TRY_BELOW_BREAK_EVEN) after 5 finished first-try task(s)',
      '    tasks: first try 5 started, 5 finished, 1 verified; 0 passed the check on the first attempt, 5 failed it, 5 handed up; control (baseline first) 0 started, 5 finished, 4 verified; 0 still open',
      '    control share: 0 of 5 started tasks (0%); the next task goes to the first try (exploration) with probability 10%',
      '    break-even p* = (cS + h) / (cO + h) = 0.6000 (from the measured attempt costs); h = 1000 micro-USD (one verification plus the cache cost of the model change), cS = 20000 micro-USD over 5, cO = 30000 micro-USD over 5',
      '    first-try success: P(success rate below p*) = 0.984; demote above 0.40, come back below 0.10 with at least 12 finished first-try tasks',
      '    against the control: P(task success worse by more than 0.075) = 0.500; demote above 0.40',
      '    cost per verified task: first try 600000 micro-USD ($0.6000), control 50000 micro-USD ($0.0500) (estimate at list prices)',
      QUALITY,
    ],
  ],
];
for (const [name, view, expected] of sliceTable) {
  test(`explain --slice lines, ${name}`, () => {
    assert.deepEqual(firstTrySliceLines(view), expected);
  });
}

const cost = (over = {}) => ({
  setting: 'auto',
  started: 4,
  open: 1,
  handedUp: 1,
  completedOnFirstTry: 1,
  finished: 3,
  verified: 2,
  controlStarted: 2,
  controlVerified: 1,
  slices: 1,
  compared: 1,
  spentMicroUsd: 110_000,
  baselineEstimateMicroUsd: 240_000,
  savedMicroUsd: 130_000,
  estimate: false,
  groups: [{ sliceId: 'issue-fix', baselineModelId: 'claude-opus-5-5', firstTryModelId: 'claude-sonnet-5-5', started: 4, handedUp: 1, completedOnFirstTry: 1, finished: 3, verified: 2, controlFinished: 2, controlVerified: 1, spentMicroUsd: 110_000, baselineEstimateMicroUsd: 240_000, savedMicroUsd: 130_000, estimate: false }],
  ...over,
});
const CAVEAT = 'control share caveat: the baseline estimate is the cost per verified task of the control (2 started, 1 verified), the small random share of low-risk tasks, at most 10%, that the route runs on the baseline first so the two can be compared. A small sample makes it noisy.';
const COST_HEAD = 'First-try routing (Sonnet-first), routing.firstTry auto:';
const COUNTS = ['started on the first try: 4 (1 still open)', 'handed up to a stronger model: 1', 'completed on the first try: 1', 'finished: 3, verified: 2'];

const costTable = [
  ['no first-try task has run', { ...cost(), started: 0, open: 0, groups: [] }, ['first-try routing: no first-try task has run in this workspace yet (routing.firstTry auto)']],
  [
    'saved against the baseline estimate',
    cost(),
    [
      COST_HEAD,
      ...COUNTS,
      'spent on the finished first-try tasks: 110000 micro-USD ($0.1100)',
      'baseline estimate for the same verified tasks: 240000 micro-USD ($0.2400)',
      'saved against the baseline estimate: 130000 micro-USD ($0.1300)',
      'compared for 1 of 1 slice(s) with finished first-try tasks; the money figures cover only those',
      '- issue-fix: claude-sonnet-5-5 before claude-opus-5-5, 4 started, 1 handed up, 1 completed on the first try, 3 finished, 2 verified; saved 130000 micro-USD',
      CAVEAT,
      QUALITY,
    ],
  ],
  [
    'spent more than the baseline estimate, labelled an estimate',
    cost({ spentMicroUsd: 300_000, baselineEstimateMicroUsd: 240_000, savedMicroUsd: -60_000, estimate: true, groups: [{ ...cost().groups[0], spentMicroUsd: 300_000, savedMicroUsd: -60_000, estimate: true }] }),
    [
      COST_HEAD,
      ...COUNTS,
      'spent on the finished first-try tasks: 300000 micro-USD ($0.3000) (estimate at list prices)',
      'baseline estimate for the same verified tasks: 240000 micro-USD ($0.2400)',
      'spent more than the baseline estimate: 60000 micro-USD ($0.0600) (estimate at list prices)',
      'compared for 1 of 1 slice(s) with finished first-try tasks; the money figures cover only those',
      '- issue-fix: claude-sonnet-5-5 before claude-opus-5-5, 4 started, 1 handed up, 1 completed on the first try, 3 finished, 2 verified; spent 60000 micro-USD more',
      CAVEAT,
      QUALITY,
    ],
  ],
  [
    'no figure can be computed: unknown, never zero',
    cost({ spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null, compared: 0, groups: [{ ...cost().groups[0], spentMicroUsd: null, baselineEstimateMicroUsd: null, savedMicroUsd: null }] }),
    [
      COST_HEAD,
      ...COUNTS,
      'spent on the finished first-try tasks: unknown',
      'baseline estimate for the same verified tasks: unknown (no control task has been verified with every cost known)',
      'saved or spent against the baseline estimate: unknown',
      'compared for 0 of 1 slice(s) with finished first-try tasks; the money figures cover only those',
      '- issue-fix: claude-sonnet-5-5 before claude-opus-5-5, 4 started, 1 handed up, 1 completed on the first try, 3 finished, 2 verified; saved or spent: unknown',
      CAVEAT,
      QUALITY,
    ],
  ],
];
for (const [name, view, expected] of costTable) {
  test(`cost-report lines, ${name}`, () => {
    assert.deepEqual(firstTryCostLines(view), expected);
  });
}

test('no line claims quality, and no money figure is a float', () => {
  const all = [...firstTryCostLines(cost()), ...firstTrySliceLines({ sliceId: 'issue-fix', setting: 'auto', groups: [group()] }), firstTryStatusLine(status())].join('\n');
  assert.doesNotMatch(all, /\b(better|worse quality|higher quality|good enough)\b/i);
  assert.doesNotMatch(all, /\d\.\d+ micro-USD/);
});
