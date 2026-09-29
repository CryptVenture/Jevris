// P6 test entry: a worker that takes jobs and never answers (the caller's timeout does the work inline).
import { parentPort } from 'node:worker_threads';

parentPort?.on('message', () => undefined);
