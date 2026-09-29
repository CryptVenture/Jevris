// P6 test entry: what the sidecar's entry does when it starts again as the check-output worker.
import { isOutputWorker, runOutputWorker } from '../../dist/index.js';

if (isOutputWorker()) runOutputWorker();
