// Removes a temporary tree that tests and smoke runs create. Windows refuses to remove a folder
// that is a live process's working folder, or a file a live process has open or loaded (a
// native addon): the removal is retried for about 5 s, and if it still fails on Windows the error
// names the processes then running whose command line names the tree, and every node,
// PowerShell and cmd process with its parent, so the holder is known.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';

/** Processes that may hold `dir` on Windows, one line each; empty elsewhere or when unreadable. */
export function windowsHolders(dir) {
  if (process.platform !== 'win32') return [];
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  let rows = [];
  try {
    rows = JSON.parse(listed.stdout);
  } catch {
    return [];
  }
  const lower = dir.toLowerCase();
  return (Array.isArray(rows) ? rows : [rows])
    .filter((row) => row !== null && typeof row === 'object' && (String(row.CommandLine ?? '').toLowerCase().includes(lower) || /^(node|powershell|pwsh|cmd)\.exe$/i.test(String(row.Name ?? ''))))
    .map((row) => `pid ${row.ProcessId} (parent ${row.ParentProcessId}) ${row.Name}: ${String(row.CommandLine ?? '').slice(0, 300)}`);
}

/** rmSync(dir, recursive, force) with the retries and, on a Windows failure, the holders named. */
export function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : 'error';
    throw new Error(`${code} removing ${dir}; this process is ${process.pid}; processes now:\n${windowsHolders(dir).join('\n')}`, { cause: error });
  }
}
