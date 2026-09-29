/**
 * Help for the operator commands that cli.ts parses itself (credential, policy, shadow,
 * shortlist). Install, uninstall, doctor and certify take their help from F's admin-cli.ts;
 * sidecar, kill-switch, store, audit, authorize, data (B) and gates (A) print their own. `jevris help <command>` and
 * `jevris <command> --help` print the same text.
 */
const EXIT = 'Exit codes: 0 done; 2 usage error or refused request (the command prints "refused").';

export const OPERATOR_HELP: { readonly [command: string]: string } = {
  credential: `Usage: jevris credential status|set|clear
       jevris credential reenable [--home <dir>]

Manages the Jev key in the operating-system keychain. set reads the key from standard input
(a hidden prompt on a terminal), never from arguments or the environment. status prints
present or missing and never the key. clear removes it.

reenable lets Jev decide again after the provider refused billing (402) or the account (403);
until then Jevris decides rules-only, and jevris status and jevris doctor show why. Run it
once the cause is fixed at the provider. It needs a person at an interactive terminal (no --yes, no --json),
asks y/N, and calls nothing: the next Jev call comes from ordinary use. The sidecar must be
running. A refused key (401) is not cleared by reenable; store a new key with set.

${EXIT}
reenable exits 1 when Jev was not re-enabled (the answer was no, the key was refused, or the
sidecar is not running).

Examples:
  jevris credential status
  jevris credential set            (then paste the key and press Enter)
  printf '%s' "$KEY" | jevris credential set
  jevris credential clear
  jevris credential reenable       (at a terminal, then answer y)`,
  policy: `Usage: jevris policy check [--home <dir>] --workspace <dir> --would-send-source [--project <file>]
       jevris policy stage [--home <dir>] --workspace <dir> --manifest <file>
       jevris policy rollback [--home <dir>] --workspace <dir>

Host policy administration. check explains whether source egress would be allowed for the
workspace, and never sends anything. stage stages a policy pack manifest; rollback restores the
previous staged policy. A raw key in a project file is refused.

Options:
  --home <dir>          Jevris home (default: JEVRIS_HOME, else your home directory)
  --workspace <dir>     The workspace the policy applies to (required)
  --would-send-source   check: ask about source egress
  --project <file>      check: a project policy file to include
  --manifest <file>     stage: the pack manifest to stage

${EXIT}

Examples:
  jevris policy check --workspace . --would-send-source
  jevris policy stage --workspace . --manifest pack.json
  jevris policy rollback --workspace .`,
  shadow: `Usage: jevris shadow [--home <dir>] --fixture <file> [--out <file>]

Compares recorded labels in shadow mode and prints the report. Nothing is applied, and a shadow
report is not a pass. --out may not point inside .jevris/packs.

Options:
  --home <dir>      Jevris home (default: JEVRIS_HOME, else your home directory)
  --fixture <file>  The labelled fixture to replay (required)
  --out <file>      Also write the report to this file

${EXIT}

Example:
  jevris shadow --fixture labels.json --out shadow.json`,
  shortlist: `Usage: jevris shortlist [--home <dir>] [--intent <text>] [--skills-root <dir>] [--evidence-root <dir>] [--skill-id <id>] [<evidence-id>...]

Names the installed skills that match an intent, with the evidence ids given. Ranking reads
skill text only; no skill code runs.

Options:
  --home <dir>            Jevris home (default: JEVRIS_HOME, else your home directory)
  --intent <text>         What the skills are for
  --skills-root <dir>     Skills folder to rank (default: the installed skills)
  --evidence-root <dir>   Evidence folder the ids refer to
  --skill-id <id>         Rank only this skill

${EXIT}

Example:
  jevris shortlist --intent "checkpoint before a refactor"`,
};

export function isOperatorHelpTopic(command: string): boolean {
  return Object.hasOwn(OPERATOR_HELP, command);
}
