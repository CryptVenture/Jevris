---
name: configure
description: Show the effective Jevris settings and where each comes from. Read-only here: settings change only with the jevris CLI. Use when the user asks how Jevris is configured.
tools: jevris_configure
invocation: user
---

# Jevris configure

Run this skill only when the user asks for it.

Purpose: show the settings that apply now and where each value comes from.

Required evidence: none.

Steps:
1. Call `jevris_configure` with no arguments.
2. Report each effective setting with its source.
3. If the user wants to change a setting, give the exact terminal command, `jevris configure set <key> <value>`, for the user to run. Do not run it for them.

Output contract: one line per setting, `key: value (source)`. Say that native harness permissions were not changed.

Stop when:
- the settings are shown: stop;
- a change is wanted: give the command and stop. This tool cannot change settings, native permissions or credentials.
