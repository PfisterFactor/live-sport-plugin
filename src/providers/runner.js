/**
 * runner.js — launcher for the vendored provider runners.
 *
 * gasm_india.js and the StreamCorner chunks are obfuscated scripts copied from
 * the embed sites. They run in a child Bun process with no inherited
 * environment beyond PATH.
 */

const { execFile } = require('child_process');
const path = require('path');

const RUNNER_TIMEOUT_MS = 15000;

/**
 * Runs a provider runner script and resolves with its combined stdout+stderr.
 * Never rejects: spawn errors and timeouts resolve with whatever output exists.
 */
function runProviderScript(scriptPath, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { timeout: RUNNER_TIMEOUT_MS, env: { PATH: process.env.PATH } },
      (err, stdout, stderr) => {
        if (err) console.warn(`[runner] ${path.basename(scriptPath)} exited with error: ${err.message}`);
        resolve(`${stdout}\n${stderr}`);
      }
    );
  });
}

module.exports = { runProviderScript };
