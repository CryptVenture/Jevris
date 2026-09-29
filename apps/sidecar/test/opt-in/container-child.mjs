// Runs inside the container for container.test.mjs: `start` runs a sidecar for JEVRIS_HOME
// until the container stops; `health` and `refused` print one JSON line from a client.
const { startDaemon, sidecarRequest, detectLocality } = await import('../../dist/index.js');

const mode = process.argv[2];
const home = process.env.JEVRIS_HOME;
if (mode === 'start') {
  const started = await startDaemon({ home, packageOps: false, idleMs: 0, store: false, log: () => undefined });
  if (!started.ok) {
    console.error(started.message);
    process.exit(1);
  }
  process.on('SIGTERM', () => void started.daemon.stop('SIGTERM').then(() => process.exit(0)));
} else {
  const answer = await sidecarRequest({ home, op: 'health', scope: 'cli', body: {} });
  console.log(JSON.stringify({ locality: detectLocality(), answer }));
}
