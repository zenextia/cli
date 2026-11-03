// Run the CLI in-process against a fake backend, capturing its output.

import { run } from '../src/cli.js';
import { tempDir } from './project.js';

function sink(isTTY = false) {
  const stream = {
    text: '',
    isTTY,
    write(chunk) {
      stream.text += chunk;
      return true;
    },
  };
  return stream;
}

/** The "browser": follow the authorization redirect to the loopback server. */
export async function followInBrowser(url) {
  const response = await fetch(url);
  await response.text();
}

export function cliHarness(backend, { configDir = tempDir('zenextia-cli-config-') } = {}) {
  return {
    configDir,
    async run(argv, deps = {}) {
      const stdout = sink();
      const stderr = sink();
      const code = await run(argv, {
        env: { ZENEXTIA_CONFIG_DIR: configDir, ZENEXTIA_API: backend.base },
        stdout,
        stderr,
        openBrowser: followInBrowser,
        pollIntervalMs: 5,
        retryDelayMs: 5,
        loginTimeoutMs: 5_000,
        ...deps,
      });
      let json = null;
      if (argv.includes('--json')) json = JSON.parse(stdout.text);
      return { code, stdout: stdout.text, stderr: stderr.text, json };
    },
  };
}
