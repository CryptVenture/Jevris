/**
 * Quoting one value for a command line Jevris prints for a person to copy and run.
 *
 * A hint such as `jevris pack install <folder>` is only useful if it still works when the folder
 * is under a name with a space in it (`/Volumes/My Drive/...`, `C:\Program Files\...`). The value
 * is quoted only when it needs it, so a plain value prints exactly as it always did.
 *
 * - POSIX shells (sh, bash, zsh, fish): single quotes, and `'\''` for an embedded single quote.
 *   Nothing inside single quotes is expanded, so `$`, backticks and `~` are safe.
 * - Windows (cmd.exe and PowerShell): double quotes, an embedded double quote as `\"` and a run
 *   of backslashes before the closing quote doubled (the CommandLineToArgvW rules the spawn helper
 *   in this package also follows). This is for a line a person pastes; it is not the caret
 *   escaping `escapeCmdArgument` applies to a cmd.exe shim. cmd.exe still expands `%NAME%` inside
 *   double quotes, which no quoting can prevent, so such a value is quoted but not made inert.
 *
 * The output is never used to spawn a process. Spawning takes an argument vector and no shell.
 */

const POSIX_PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/;
const WINDOWS_PLAIN = /^[A-Za-z0-9_@+=:,./\\-]+$/;

export function shellQuote(value: string, platform: string = process.platform): string {
  if (platform === 'win32') {
    if (WINDOWS_PLAIN.test(value)) return value;
    const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    return `"${escaped}"`;
  }
  if (POSIX_PLAIN.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
