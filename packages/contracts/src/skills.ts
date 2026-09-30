import { PUBLIC_COMMAND_NAMES } from './commands.js';

/**
 * The skills Jevris installs into every harness: one per public command, plus `guide`, a short
 * tour that has no command of its own (it points at `status` and the docs). The installer, the
 * certification checks and the pack check list skills from here, never from the command list.
 */
export const SKILL_NAMES = [...PUBLIC_COMMAND_NAMES, 'guide'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];
