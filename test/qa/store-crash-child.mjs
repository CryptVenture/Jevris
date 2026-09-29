/**
 * Child process for the crash-point test (QA-03): commits decisions 0..killAt-1, then kills
 * itself with SIGKILL from inside the transaction of commit `killAt`, between the store writes
 * and the transaction commit. Not a test file; test/qa/store-properties.test.mjs spawns it.
 */
import { commitOwned, openStore } from '@jevris/store';

const [path, killAtText] = process.argv.slice(2);
const killAt = Number(killAtText);
const store = openStore({ path, role: 'in-process-test', workspaceId: 'wsKill', hostScope: 'host-qa' });
if (!store.ok) {
  process.stderr.write(`open failed: ${JSON.stringify(store)}\n`);
  process.exit(3);
}
for (let i = 0; ; i += 1) {
  const result = commitOwned(store, { decisionId: `dec${i}`, operationId: `op${i}`, reservationMicroUsd: BigInt(i) }, () => {
    if (i === killAt) process.kill(process.pid, 'SIGKILL');
  });
  if (!result.ok) {
    process.stderr.write(`commit ${i} refused: ${JSON.stringify(result)}\n`);
    process.exit(4);
  }
}
