/**
 * The link between an interactive harness session and a task (owner decision 29423b6, D's
 * finding 7; B, D and E). A Kilo or OpenCode main session may be switched per turn only when it
 * is linked to its task; a session with no link gets advice only.
 *
 * - The sidecar resolves the session from its own records, never from a client claim: a named
 *   session must match a recorded, active main session of that harness in this workspace exactly,
 *   and without a name exactly one such session may have been seen recently. More than one is an
 *   `ambiguous` answer that lists them, so a person can name one.
 * - A link made from the CLI needs an interactive terminal (B's security review); plan and handoff
 *   links are made by the sidecar itself. Unlinking only tightens and works from any CLI channel.
 * - The answer always names the session it linked, so a wrong guess is visible.
 */
import { defineContract, type Contract } from './contract.js';
import { HarnessIdSchema, Id, NonNegativeInteger } from './primitives.js';
import * as S from './schema.js';

/** A harness session id as the sidecar records it. */
export const SESSION_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$';
const SessionId = S.string({ pattern: SESSION_ID_PATTERN });

export const SESSION_LINK_VIA = ['route', 'plan', 'handoff'] as const;
export type SessionLinkVia = (typeof SESSION_LINK_VIA)[number];

/** The most candidates an ambiguous answer lists. */
export const SESSION_LINK_MAX_CANDIDATES = 8;

/** Why a link or unlink is refused (the sidecar's reason codes). */
export const SESSION_LINK_REFUSALS = [
  'UNKNOWN_SESSION',
  'SESSION_ENDED',
  'TASK_UNKNOWN',
  'TASK_NOT_ACTIVE',
  'SESSION_ALREADY_LINKED',
  'CHANNEL_REFUSED',
  'KILL_SWITCH_ACTIVE',
] as const;

export const SessionLinkViewSchema = S.object(
  {
    harness: HarnessIdSchema,
    sessionId: SessionId,
    taskId: Id,
    linkedAtMs: NonNegativeInteger,
    via: S.enumOf(SESSION_LINK_VIA),
  },
  {
    /**
     * The link belongs to an in-use owned-worker worktree of this workspace, listed in the parent's
     * status (D's ownedWorktreeWorkspaces; B's sessionLinksOf). Absent for the workspace's own links.
     */
    worker: S.literal(true),
  },
);
export type SessionLinkView = S.Static<typeof SessionLinkViewSchema>;

const Candidate = S.object({ harness: HarnessIdSchema, sessionId: SessionId, lastSeenAtMs: NonNegativeInteger });

export const SessionLinkResultSchema = S.discriminatedUnion('result', [
  S.object({ result: S.literal('linked'), harness: HarnessIdSchema, sessionId: SessionId, taskId: Id, lastSeenAtMs: NonNegativeInteger, via: S.enumOf(SESSION_LINK_VIA) }),
  S.object({ result: S.literal('already-linked'), harness: HarnessIdSchema, sessionId: SessionId, taskId: Id, lastSeenAtMs: NonNegativeInteger, via: S.enumOf(SESSION_LINK_VIA) }),
  S.object({ result: S.literal('ambiguous'), candidates: S.array(Candidate, { minItems: 2, maxItems: SESSION_LINK_MAX_CANDIDATES }) }),
  S.object({ result: S.literal('unlinked'), harness: HarnessIdSchema, sessionId: SessionId }),
  S.object({ result: S.literal('not-linked'), harness: HarnessIdSchema, sessionId: SessionId }),
]);
export type SessionLinkResult = S.Static<typeof SessionLinkResultSchema>;

export const SessionLinkResultContract: Contract<SessionLinkResult> = defineContract<SessionLinkResult>({
  name: 'SessionLinkResult',
  description:
    "The sidecar's answer to session.link and session.unlink: the session it linked or unlinked (resolved from its own records), or the recorded candidates when more than one could be meant.",
  schema: SessionLinkResultSchema,
});
