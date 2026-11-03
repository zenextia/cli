#!/usr/bin/env node
import { run } from '../src/cli.js';

const code = await run(process.argv.slice(2));
process.exitCode = code;
// Let stdout drain; force the exit if an idle keep-alive socket lingers.
setTimeout(() => process.exit(code), 1000).unref();
