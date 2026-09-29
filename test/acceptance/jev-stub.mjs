/**
 * A stand-in Jev for domain B's acceptance stories (US02, US26, US29..US31, W07).
 *
 * It serves the Jev conformance mock (`createMockFetch` from provider-typesafe, SSOT §7) on a
 * loopback port in a child process, so it keeps answering while the test process is blocked in
 * a synchronous product call. The product reaches it only through the documented test override
 * (`JEVRIS_TEST_PROVIDER_URL` and `JEVRIS_TEST_PROVIDER_KEY`, loopback only). Every request is
 * appended to a private `jev-requests.jsonl` (method, path, body text, time) so a story can read
 * what left the machine without a round trip.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './lib.mjs';

const SERVER = `
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
const [moduleUrl, log, scenarioText, lateText] = process.argv.slice(1);
const provider = await import(moduleUrl);
const scenario = scenarioText.includes(',') ? scenarioText.split(',') : scenarioText;
const mock = provider.createMockFetch({ scenario, lateMs: Number(lateText), retryAfterSeconds: 1 });
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    appendFileSync(log, JSON.stringify({ method: req.method, path: req.url, body, atMs: Date.now() }) + '\\n');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value;
      const answer = await mock('https://api.typesafe.ai' + req.url, { method: req.method, headers, body, signal: abort.signal });
      const out = Buffer.from(await answer.arrayBuffer());
      const sent = {};
      answer.headers.forEach((value, key) => (sent[key] = value));
      res.writeHead(answer.status, sent);
      res.end(out);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      res.destroy();
    }
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n'));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

/**
 * Starts the stub. `scenario` is one conformance scenario or a comma-separated script (the last
 * entry repeats). Returns `{ url, env, requests() }`; stopped when the test ends.
 */
export async function startJevStub(t, { scenario = 'valid', lateMs = 60_000 } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'jevris-jev-stub-')));
  const log = join(dir, 'jev-requests.jsonl');
  const moduleUrl = pathToFileURL(join(repoRoot, 'packages', 'provider-typesafe', 'dist', 'index.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', SERVER, moduleUrl, log, scenario, String(lateMs)], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('the Jev stub did not start')), 15_000);
    child.once('exit', () => reject(new Error('the Jev stub exited')));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const at = buffer.indexOf('\n');
      if (at < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, at)).port);
    });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    key: 'acceptance-test-key',
    env: { JEVRIS_TEST_PROVIDER_URL: url, JEVRIS_TEST_PROVIDER_KEY: 'acceptance-test-key' },
    /** Every request the stub received so far, oldest first. */
    requests() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
