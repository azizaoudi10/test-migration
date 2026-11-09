import { parentPort, workerData } from 'node:worker_threads';
import { runSearch, type SearchRequest } from './reviewer-search.js';

/**
 * Search worker: executes an untrusted model-supplied regex away from the
 * main process so even catastrophic backtracking can only burn this thread.
 * reviewer-tools enforces the hard timeout and terminates the worker.
 */
void runSearch(workerData as SearchRequest).then((text) => {
  parentPort?.postMessage({ text });
});
