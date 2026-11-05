// Runs npm against the generated project.
//
// Short steps (install, build, boot check) use child_process.exec, because they need
// the captured output for the failure log and they finish on their own. The `exec`
// prefix makes the shell replace itself with the command, so signals reach npm or
// node rather than a wrapper shell.
//
// The dev server uses child_process.spawn. exec keeps everything a child prints for
// its callback, which is the wrong fit for a process that can log for days.

import { exec, spawn } from 'node:child_process';
import net from 'node:net';
import { stripVTControlCharacters } from 'node:util';

const SHELL_EXEC = process.platform === 'win32' ? '' : 'exec ';
const LOG_BUFFER = 64 * 1024 * 1024;
const BOOT_TIMEOUT_MS = 10_000;

// Generated code runs with the user's privileges. Removing credentials from its
// environment is not a sandbox, but it does keep the LLM key and cloud tokens out
// of reach of a stray `process.env`.
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|DATABASE_URL|DSN|^ANTHROPIC_|^OPENAI_/i;

export function childEnv(extra = {}, source = process.env) {
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => !SECRET_ENV.test(name)));
  return { ...env, ...extra };
}

// npm reports these as text. They come from the machine or network, not the app's
// code, so a fix round would only spend tokens. A wrong package version (ETARGET,
// E404) is left out on purpose: the model can fix that one.
const ENVIRONMENT_FAILURE = /\bE(NOTFOUND|TIMEDOUT|CONNREFUSED|CONNRESET|AI_AGAIN|NOSPC|ACCES|PERM)\b|npm error network/;

/** A project step failed. `fixable` says whether sending the log to the model could help. */
export class StepError extends Error {
  constructor(stage, log) {
    super(`${stage} failed`);
    this.name = 'StepError';
    this.stage = stage;
    this.log = stripVTControlCharacters(log).trim();
    this.fixable = !(stage === 'npm install' && ENVIRONMENT_FAILURE.test(this.log));
  }
}

const running = new Set();

// The dev server runs in its own process group so a stop reaches every process
// it started. npm runs scripts through a shell, and on Linux a signal sent to npm
// alone did not always get past that shell, which left Vite running.
const OWN_GROUP = process.platform !== 'win32';

/** Stops a child, and its whole process group if it has one. */
export function stopProcess(child, signal = 'SIGTERM') {
  if (child.ownGroup) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone, so fall through to the child itself.
    }
  }
  child.kill(signal);
}

/** Stops any child that is still running. Called on exit and on cancel. */
export function killRunning(signal = 'SIGTERM') {
  for (const child of running) stopProcess(child, signal);
}

function track(child) {
  running.add(child);
  child.once('exit', () => running.delete(child));
  return child;
}

function run(stage, command, { cwd, env, timeout }) {
  return new Promise((resolve, reject) => {
    track(
      exec(`${SHELL_EXEC}${command}`, { cwd, env, timeout, maxBuffer: LOG_BUFFER }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const why = err.killed ? `Timed out after ${timeout / 1000}s.\n` : '';
        reject(new StepError(stage, `${why}${stderr}\n${stdout}`));
      }),
    );
  });
}

// --ignore-scripts: a model-chosen dependency does not get to run code during
// install. --legacy-peer-deps: a slightly stale peer range should not cost a whole
// repair round when the app would run fine.
export function installDependencies(cwd) {
  return run('npm install', 'npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund --loglevel=error', {
    cwd,
    env: childEnv(),
    timeout: 10 * 60_000,
  });
}

export function buildApp(cwd) {
  // Building into node_modules keeps the check from touching dist/.
  return run('vite build', 'npm run build -- --outDir node_modules/.ignite-check --emptyOutDir', {
    cwd,
    env: childEnv(),
    timeout: 5 * 60_000,
  });
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const canConnect = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/** Starts server/index.js and confirms it listens on the assigned port. */
export async function checkServerBoots(cwd) {
  const port = await getFreePort();
  const node = process.platform === 'win32' ? `"${process.execPath}"` : `'${process.execPath.replaceAll("'", `'\\''`)}'`;

  let exited = false;
  let logs = '';
  let child;
  const finished = new Promise((resolve) => {
    child = track(
      exec(
        `${SHELL_EXEC}${node} server/index.js`,
        { cwd, env: childEnv({ PORT: String(port) }), maxBuffer: LOG_BUFFER },
        (err, stdout, stderr) => {
          exited = true;
          logs = `${stderr}\n${stdout}`;
          resolve(err);
        },
      ),
    );
  });

  // A generated server may trap SIGTERM and never exit, which must not hang the check.
  const stopServer = async () => {
    child.kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 2000);
    await finished;
    clearTimeout(force);
  };

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (!exited && Date.now() < deadline) {
    if (await canConnect(port)) {
      await stopServer();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (!exited) await stopServer();
  throw new StepError(
    'server boot',
    exited && !child.killed
      ? `server/index.js exited before listening on PORT=${port}.\n${logs}`
      : `server/index.js did not listen on 127.0.0.1:${port} (process.env.PORT) within ${BOOT_TIMEOUT_MS / 1000}s.\n${logs}`,
  );
}

// The trailing slash is required. A write can end partway through the URL, and
// "http://localhost:51" must not be mistaken for the whole address.
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//;
const URL_SEARCH_WINDOW = 4096;

/**
 * Runs `npm run dev`, streaming its output to the terminal without retaining it.
 * pipe() also applies backpressure, so a stalled terminal slows the child down
 * rather than growing a queue in this process.
 * Returns the child, plus a promise for its exit and a callback for the local URL.
 */
export function startDevServer(cwd, { apiPort, onReady }) {
  const child = track(
    spawn('npm', ['run', 'dev'], {
      cwd,
      env: childEnv({ PORT: String(apiPort), ...(process.stdout.isTTY ? { FORCE_COLOR: '1' } : {}) }),
      shell: process.platform === 'win32', // npm is a .cmd file on Windows, which needs a shell.
      detached: OWN_GROUP,
    }),
  );
  child.ownGroup = OWN_GROUP && child.pid !== undefined;

  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });

  // Keeps a short tail for a URL split across chunks, and only until the URL is found.
  let tail = '';
  const findUrl = (chunk) => {
    const text = tail + chunk;
    const match = stripVTControlCharacters(text).match(LOCAL_URL);
    if (match) {
      child.stdout.off('data', findUrl);
      tail = '';
      onReady(match[0]);
    } else {
      tail = text.slice(-URL_SEARCH_WINDOW);
    }
  };
  child.stdout.on('data', findUrl);

  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited };
}

/** Opens a URL in the default browser. The URL comes from LOCAL_URL, so it is safe to place in a command. */
export function openBrowser(url) {
  const opener = { darwin: 'open', win32: 'start ""' }[process.platform] ?? 'xdg-open';
  exec(`${opener} ${url}`, () => {});
}
