/**
 * runner.js — least-privilege launcher for the vendored provider runners.
 *
 * lock.js / gasm_india.js are obfuscated scripts copied from the embed sites.
 * They run in a child process that gets no inherited environment, read access
 * only to the runner directory and node_modules, and no child processes or
 * workers (Node permission model). Under Bun the flags are unavailable, so the
 * child falls back to a plain `node` spawn.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUNNER_TIMEOUT_MS = 15000;

/** Nearest ancestor node_modules of the runner directory. */
function findNodeModules(from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function buildCommand(scriptPath) {
  const flags = process.allowedNodeEnvironmentFlags;
  if (process.versions.bun || !flags || !flags.has('--permission')) {
    return { file: 'node', prefix: [] };
  }
  const runnerDir = path.dirname(scriptPath);
  const prefix = ['--permission', `--allow-fs-read=${runnerDir}`, '--allow-addons'];
  const nodeModules = findNodeModules(runnerDir);
  if (nodeModules) prefix.push(`--allow-fs-read=${nodeModules}`);
  return { file: process.execPath, prefix };
}

/**
 * Runs a provider runner script and resolves with its combined stdout+stderr.
 * Never rejects: spawn errors and timeouts resolve with whatever output exists.
 */
function runProviderScript(scriptPath, args) {
  const { file, prefix } = buildCommand(scriptPath);
  return new Promise((resolve) => {
    execFile(
      file,
      [...prefix, scriptPath, ...args],
      { timeout: RUNNER_TIMEOUT_MS, env: { PATH: process.env.PATH } },
      (err, stdout, stderr) => {
        if (err) console.warn(`[runner] ${path.basename(scriptPath)} exited with error: ${err.message}`);
        resolve(`${stdout}\n${stderr}`);
      }
    );
  });
}

module.exports = { runProviderScript, buildCommand };
