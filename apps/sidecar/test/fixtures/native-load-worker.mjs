// A stand-in for the start of the sidecar's maintenance worker, for native-load-stop.test.mjs. It
// does what runMaintenanceWorker does around the load of the SQLite addon (enterNativeLoad before it,
// leaveNativeLoad after it), with the three slow parts replaced by waits a test can size: the boot
// (modules loading, asynchronous), the load itself and the sweep after it (both synchronous, as the
// addon's initialiser and a SQLite write are: the thread cannot be asked anything while it is in
// them, and a thread ended inside the load is what aborts the sidecar). Every step is noted in the
// log file the job's `path` names; the waits come from `hostScope`, a JSON text. A build without the
// handshake exports neither function, so the load is then simply unguarded. Never started by product code.
import { appendFileSync } from 'node:fs';
import { workerData } from 'node:worker_threads';

const { path: log, hostScope } = workerData.job;
const { bootMs, loadMs } = JSON.parse(hostScope);
const note = (line) => appendFileSync(log, `${line}\n`);
const maintenance = await import('../../dist/maintenance.js');
const enter = maintenance.enterNativeLoad ?? (() => true);
const leave = maintenance.leaveNativeLoad ?? (() => undefined);
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until);
};

note('booted');
await new Promise((resolve) => setTimeout(resolve, bootMs));
if (enter(workerData.load)) {
  note('loading');
  spin(loadMs);
  note('loaded');
  leave(workerData.load);
  // The sweep: far longer than any test waits, so only a stop ends it.
  spin(120_000);
} else {
  note('declined');
}
