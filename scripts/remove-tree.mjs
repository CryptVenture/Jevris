// Removes a temporary tree that tests and smoke runs create. Windows refuses to remove a folder
// that is a live process's working folder, or a file a live process has open or loaded (a
// native addon): the removal is retried for up to 30 s there, and if it still fails the error
// names the processes then running whose command line names the tree, and every node,
// PowerShell and cmd process with its parent, so the holder is known.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/** The Windows process table (pid, parent pid, name, command line); empty elsewhere or when unreadable. */
export function windowsProcesses() {
  if (process.platform !== 'win32') return [];
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  let rows = [];
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return [];
  }
  return (Array.isArray(rows) ? rows : [rows])
    .filter((row) => row !== null && typeof row === 'object')
    .map((row) => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), name: String(row.Name ?? ''), commandLine: String(row.CommandLine ?? '') }));
}

/** Processes that may hold `dir` on Windows, one line each; empty elsewhere or when unreadable. */
export function windowsHolders(dir) {
  const lower = dir.toLowerCase();
  return windowsProcesses()
    .filter((row) => row.commandLine.toLowerCase().includes(lower) || /^(node|powershell|pwsh|cmd)\.exe$/i.test(row.name))
    .map((row) => `pid ${row.pid} (parent ${row.ppid}) ${row.name}: ${row.commandLine.slice(0, 300)}`);
}

/**
 * How long a Windows removal keeps trying. A handle closes some time after its process exits, and
 * a scanner opens new files after they are written: at 6d1e6d1 a folder whose sidecar had
 * stopped was still EBUSY after rmSync's own 5.5 s of retries, with no process left naming it.
 */
export const WINDOWS_REMOVE_WINDOW_MS = 30_000;

/** rmSync(dir, recursive, force) with the retries and, on a Windows failure, the holders named. */
export function removeTree(dir, windowMs = WINDOWS_REMOVE_WINDOW_MS) {
  const until = Date.now() + windowMs;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
      return;
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : 'error';
      if (['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(code) && Date.now() < until) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        continue;
      }
      throw new Error(`${code} removing ${dir}; this process is ${process.pid}; processes now:\n${windowsHolders(dir).join('\n')}`, { cause: error });
    }
  }
}
