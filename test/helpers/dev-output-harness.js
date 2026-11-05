// Runs startDevServer on a project given as argv[2] and reports peak memory and the
// announced URLs on stderr. Run it with stdout discarded: it exists to measure what
// this process holds on to while the dev server's output passes through it.

import { startDevServer } from '../../src/executor.js';

const urls = [];
let peakRss = 0;
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
};

const timer = setInterval(sample, 20);
const { exited } = startDevServer(process.argv[2], { apiPort: 1, onReady: (url) => urls.push(url) });
const { code, error } = await exited;
clearInterval(timer);
sample();

// npm writes its script banner to stderr too, so the result gets a marker.
process.stderr.write(`\nRESULT ${JSON.stringify({ peakRss, urls, code, error: error?.code })}\n`);
