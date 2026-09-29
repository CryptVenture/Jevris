/**
 * A child process whose stdin is safe to write after the child has gone.
 *
 * A child can exit between spawn() and a write to its stdin: the parent is descheduled on a
 * loaded host, or the child fails at once by design. That write then fails with EPIPE (or a
 * reset) on the stdin stream, and with no listener the stream's 'error' is an uncaught exception
 * that fails the caller, typically a whole test file, for a reason that has nothing to do with
 * what it checks. The caller's own 'exit' or 'close' handling already reports the child's end,
 * so the stdin error carries no further information and is dropped here.
 *
 * Every spawn in the scripts and tests that writes to or ends a child's stdin goes through this.
 */
export function guardStdin(child) {
  child.stdin?.on('error', () => {});
  return child;
}
