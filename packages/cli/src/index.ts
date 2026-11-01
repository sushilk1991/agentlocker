#!/usr/bin/env node
import { runCli } from './cli.js';
const controller = new AbortController();
const abort = () => controller.abort();
process.once('SIGINT',abort);
process.once('SIGTERM',abort);
try { process.exitCode = await runCli(process.argv.slice(2),{signal:controller.signal}); }
finally { process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort); }
