/** `jevris route learning` help: one source, shown by `--help`, `jevris help route` and docs. */
export const ROUTE_LEARNING_HELP = `Usage: jevris route learning status [--slice <slice>] [--json]
       jevris route learning off | on [--yes] [--json]
       jevris route learning pin <slice> (<model> [--effort <level>] | --advise) [--yes] [--json]
       jevris route learning unpin <slice> [--yes] [--json]
       jevris route learning reset [--clear-evidence | --machine] [--yes] [--json]
       jevris route learning rollback <version> [--yes] [--json]
       jevris route learning automatic on|off [--yes] [--json]
       jevris route learning accept | reject <proposal-id> [--yes] [--json]
       jevris route learning gone [list | clear <model-id> | clear --all] [--yes] [--json]
       jevris route learning export-cases [--json]

Route learning chooses the model and effort for managed workers, per slice of work. It is on
from install, but managed workers start only when orchestration is enabled,
routing.managedWorkers is bounded-auto and the kill switch is off. The default is
bounded-auto with orchestration on, so owned workers start when a person submits a plan,
within its budget, the kill switch and certification. On a harness not certified for
worker.route (jevris certify), routing only advises: the approved model runs at its default
effort.

On day 1 each slice follows the baseline model, Opus 5.5 (claude-opus-5-5) at its default
effort, medium. Version 1.2 ships no signed baseline release, and a baseline alone never
switches a slice: a slice switches only after this workspace has at least 12 randomized,
verified outcomes on both the candidate arm and the default arm. Every verified outcome
updates the evidence, so a slice is activated, kept or demoted as the evidence says. An arm
is a model at an effort level: learning tries Opus 5.5 at low, medium and high effort. Demotion back to the
baseline model at its default effort is fast. Every change makes a new policy version, so a
reset, a pin or a rollback undoes it.

status     Each slice's mode (active, advice only, or pinned) and the version that set it; the
           signed baseline prior, the other workspaces' outcomes on this machine and the local
           outcomes, shown apart; the posterior; the published priors; any pending proposal;
           how often the chosen model agreed with the rules-only choice (rates, never a
           saving); the Sonnet-first first-try and control tasks (cost per verified task,
           an estimate when priced from usage; quality is never claimed); and the models
           found gone on this machine.
off        Stops every switch and all exploration in this workspace: managed workers keep their
           model. Outcomes are still counted. on turns learning back on.
pin        Pins a slice to a model, at an effort level with --effort (else the model's default),
           or to advice only (--advise). A pin always wins: learning never changes a pinned
           slice, and an advice-only pin never launches a worker.
unpin      Removes the pin: the slice returns to the baseline and local-evidence decision.
reset      Every slice back to the day-1 baseline. Local outcomes are kept unless
           --clear-evidence, which also deletes them and withdraws this workspace's share of
           the learning shared across the workspaces on this machine, and removes this
           workspace's learning records (decision outcomes, advice adherence) from the store
           and its local calibration cases file. --machine instead clears that shared
           learning for every workspace; each keeps its own outcomes and policy.
rollback   Restores an earlier version's policy as a new version.
automatic  on (the default): changes supported by the evidence apply at once, with the
           owner-locked thresholds. off: each change waits as a proposal for you to review.
accept     Accepts a pending proposal (review mode): the slice routes the proposed model.
reject     Rejects a pending proposal; the slice stays as it is.
gone       Lists the models found gone on this machine: a launch or provider call found the
           model gone (MODEL_GONE, every harness), or not accessible from one harness and
           sign-in (MODEL_NOT_ACCESSIBLE, that harness only). Jevris never recommends, routes or
           launches them here. The next registry refresh clears the list; gone clear
           <model-id>, or gone clear --all, clears it now. The record is per machine, so gone
           needs no workspace.
export-cases
           Writes this workspace's local calibration cases: each Jev decision's per-question
           provider probability joined with its verified task outcome, into a file under
           route-learning/calibration-cases in your Jevris data for a person to review. It is
           never applied or uploaded, and each export replaces the last. It asks nothing and
           needs the Jevris sidecar.

Only the CLI changes learning; no model tool can. off and automatic off only lower what learning
may do, so they apply at once; every other change needs --yes or a y/N answer on a terminal.

Options:
  --slice <slice>     status: only this slice
  --effort <level>    pin: the model's effort: low, medium, high, xhigh or max
  --advise            pin: pin to advice only
  --clear-evidence    reset: also delete the local outcomes and proposals, withdraw this
                      workspace's share of the machine-wide learning, and remove its learning
                      records from the store and its local calibration cases file
  --machine           reset: clear the learning shared by every workspace on this machine
  --all               gone clear: clear every model found gone on this machine
  --yes               Confirm without the terminal question
  --home <dir>        Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>   Workspace (default: the repository containing the current directory)
  --json              Print one JSON result line

Exit codes: 0 shown or changed; 1 refused (unknown proposal or version, a pinned slice, not
pinned, or export-cases found no sidecar, store or decision engine); 2 usage error or not
confirmed. A gone clear with nothing to clear exits 0 and changes nothing.

Examples:
  jevris route learning status
  jevris route learning off
  jevris route learning pin bounded-edit claude-opus-5-5 --effort low --yes
  jevris route learning pin bounded-edit --advise --yes
  jevris route learning reset --yes
  jevris route learning reset --machine --yes
  jevris route learning gone
  jevris route learning gone clear claude-opus-5-5 --yes
  jevris route learning export-cases`;
