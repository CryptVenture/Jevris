import { pending } from './lib.mjs';

// F's part runs in every CI cell, Windows included: apps/cli/test/launch-without-shell-tools.test.mjs
// installs into a home whose path has spaces, puts only node on PATH (no Bash, no jq) and runs
// the installed Claude (exec form), Codex and Antigravity hooks, which answer their exact
// protocol output. The story itself is about the certified Windows launcher, so it stays pending
// until the Windows runner records it: `set JEVRIS_LIVE_HARNESS=1 && jevris certify --harness claude`
// (CLA-07), with B's per-user pipe and D's Windows verification runner.
pending('US36', 'domains B and D: the per-user Windows pipe (IPC-05) and the verification runner on Windows (VER-02, VER-08); F: the Windows certification record (CLA-07), from `set JEVRIS_LIVE_HARNESS=1 && jevris certify --harness claude` on a Windows runner');
