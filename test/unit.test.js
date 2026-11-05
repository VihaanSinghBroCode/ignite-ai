import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

import { StepError, childEnv } from '../src/executor.js';
import { OutputError, createKeyTracker, parseFileMap } from '../src/parse.js';
import { PINNED_DEPENDENCIES, SCRIPTS, VITE_CONFIG, applyPolicy, findMissingPackages, hardenManifest, normalizePath } from '../src/policy.js';
import { buildFixPrompt, buildGeneratePrompt, buildRepairPrompt, SYSTEM_PROMPT } from '../src/prompts.js';
import { ProviderError, normalizeError, withRetry } from '../src/providers.js';
import { resolveProjectDir, slugify, writeProject } from '../src/writer.js';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'ignite-test-'));
const headers = (values) => new Headers(values);
const minimalApp = (extra = {}) =>
  new Map(
    Object.entries({
      'package.json': '{}',
      'index.html': '<html></html>',
      'src/main.jsx': '',
      'server/index.js': '',
      ...extra,
    }),
  );

describe('parseFileMap', () => {
  it('accepts a strict file map', () => {
    const files = parseFileMap('{"src/App.jsx":"code","a.txt":"b"}');
    assert.equal(files.get('src/App.jsx'), 'code');
    assert.equal(files.size, 2);
  });

  it('unwraps code fences and surrounding prose', () => {
    assert.equal(parseFileMap('```json\n{"a.txt":"b"}\n```').get('a.txt'), 'b');
    assert.equal(parseFileMap('Here you go:\n{"a.txt":"b"}\nEnjoy!').get('a.txt'), 'b');
  });

  it('keeps __proto__ as an ordinary key instead of polluting anything', () => {
    const files = parseFileMap('{"__proto__":"x"}');
    assert.equal(files.get('__proto__'), 'x');
    assert.equal({}.polluted, undefined);
  });

  for (const [label, input] of [
    ['invalid JSON', '{"a":'],
    ['no object', 'sorry, I cannot do that'],
    ['an array', '["a"]'],
    ['non-string values', '{"a":{"nested":true}}'],
    ['null values', '{"a":null}'],
    ['an empty object', '{}'],
  ]) {
    it(`rejects ${label}`, () => assert.throws(() => parseFileMap(input), OutputError));
  }
});

describe('createKeyTracker', () => {
  const track = (pieces) => {
    const keys = [];
    const tracker = createKeyTracker((key) => keys.push(key));
    pieces.forEach((piece) => tracker.push(piece));
    return keys;
  };

  it('finds keys across arbitrary chunk boundaries', () => {
    const doc = JSON.stringify({ 'src/App.jsx': 'const a = {"b": "c", "d": [1]};\n', 'server/index.js': 'say("hi, \\"x\\"")' });
    assert.deepEqual(track(doc.split('')), ['src/App.jsx', 'server/index.js']);
    assert.deepEqual(track([doc.slice(0, 7), doc.slice(7, 30), doc.slice(30)]), ['src/App.jsx', 'server/index.js']);
  });

  it('decodes escaped keys and ignores prose before the object', () => {
    assert.deepEqual(track(['Sure, "here": ', '{"a\\"b.js":"x"}']), ['a"b.js']);
  });

  it('starts over after reset', () => {
    const keys = [];
    const tracker = createKeyTracker((key) => keys.push(key));
    tracker.push('{"a.js":"unfinished');
    tracker.reset();
    tracker.push('{"b.js":"x"}');
    assert.deepEqual(keys, ['a.js', 'b.js']);
  });
});

describe('normalizePath', () => {
  for (const bad of [
    '../evil.js',
    'src/../../evil.js',
    '/etc/passwd',
    '~/.ssh/authorized_keys',
    'C:\\Windows\\evil.js',
    'C:/Windows/evil.js',
    'src\\..\\..\\evil.js',
    'a//b.js',
    'a/./b.js',
    'a\0b.js',
    'a\nb.js',
    '',
    'x'.repeat(300),
  ]) {
    it(`rejects ${JSON.stringify(bad.slice(0, 30))}`, () => assert.throws(() => normalizePath(bad), OutputError));
  }

  for (const disguised of ['\u200b../evil.js', '.\u200b./evil.js', '/\u200betc/passwd', 'src/\u202e../../evil.js', '\u200b', 'a\u2028b.js', 'a\u2029b.js']) {
    it(`rejects the disguised path ${JSON.stringify(disguised)}`, () => assert.throws(() => normalizePath(disguised), OutputError));
  }

  it('removes invisible characters from otherwise normal paths', () => {
    assert.equal(normalizePath('\u200b.gitignore'), '.gitignore');
    assert.equal(normalizePath('src/\u202eApp.jsx'), 'src/App.jsx');
    assert.equal(normalizePath('\ufeffsrc/App.jsx'), 'src/App.jsx');
    assert.equal(normalizePath('src/caf\u0065\u0301.js'), 'src/caf\u00e9.js');
  });

  it('accepts normal paths and strips a leading ./', () => {
    assert.equal(normalizePath('src/components/App.jsx'), 'src/components/App.jsx');
    assert.equal(normalizePath('./src/App.jsx'), 'src/App.jsx');
  });
});

describe('applyPolicy', () => {
  it('drops files that change how tools behave', () => {
    const { files, warnings } = applyPolicy(
      minimalApp({
        '.npmrc': 'registry=https://evil.example',
        '.env': 'SECRET=1',
        '.git/hooks/pre-commit': 'rm -rf /',
        '.vscode/tasks.json': '{}',
        '.claude/settings.json': '{}',
        'src/.hidden/x.js': '',
        'node_modules/react/index.js': '',
        'package-lock.json': '{}',
        'vite.config.ts': 'export default {}',
      }),
      { name: 'app' },
    );
    for (const dropped of ['.npmrc', '.env', '.git/hooks/pre-commit', '.vscode/tasks.json', '.claude/settings.json', 'src/.hidden/x.js', 'node_modules/react/index.js', 'package-lock.json', 'vite.config.ts']) {
      assert.equal(files.has(dropped), false, dropped);
    }
    assert.equal(warnings.length, 9);
  });

  it('applies the dotfile rule to names disguised with invisible characters', () => {
    const { files, warnings } = applyPolicy(minimalApp({ '\u200b.npmrc': 'registry=https://evil.example', '\u200b.gitignore': 'custom\n' }), { name: 'app' });
    assert.equal([...files.keys()].some((file) => file.includes('npmrc')), false);
    assert.equal(warnings.length, 1);
    assert.equal(files.get('.gitignore'), 'custom\n');
    assert.equal([...files.keys()].every((file) => /^[\x20-\x7e]+$/.test(file)), true);
  });

  it('keeps .gitignore and .env.example, and adds a default .gitignore otherwise', () => {
    const kept = applyPolicy(minimalApp({ '.gitignore': 'custom\n', '.env.example': 'A=1' }), { name: 'app' }).files;
    assert.equal(kept.get('.gitignore'), 'custom\n');
    assert.equal(kept.has('.env.example'), true);
    assert.match(applyPolicy(minimalApp(), { name: 'app' }).files.get('.gitignore'), /node_modules/);
  });

  it('always writes its own Vite config, even over the model version', () => {
    const { files } = applyPolicy(minimalApp({ 'vite.config.js': 'evil()' }), { name: 'app' });
    assert.equal(files.get('vite.config.js'), VITE_CONFIG);
  });

  it('rejects traversal anywhere in the response', () => {
    assert.throws(() => applyPolicy(minimalApp({ '../../evil.js': 'x' }), { name: 'app' }), OutputError);
  });

  it('rejects missing required files in a full response, but not in a fix', () => {
    assert.throws(() => applyPolicy(new Map([['src/App.jsx', '']]), { name: 'app' }), /Required files are missing/);
    const { files } = applyPolicy(new Map([['src/App.jsx', 'x']]), { name: 'app', partial: true });
    assert.deepEqual([...files.keys()], ['src/App.jsx']);
  });

  it('does not let a fix replace the Vite config', () => {
    assert.throws(() => applyPolicy(new Map([['vite.config.js', 'evil()']]), { name: 'app', partial: true }), /no usable file changes/);
  });

  it('rejects case-only collisions and file/directory conflicts', () => {
    assert.throws(() => applyPolicy(minimalApp({ 'src/App.jsx': '', 'src/app.jsx': '' }), { name: 'app' }), /letter case/);
    assert.throws(() => applyPolicy(minimalApp({ src: 'file', 'src/App.jsx': '' }), { name: 'app' }), /both a file and a directory/);
  });

  it('rejects oversized files and too many files', () => {
    assert.throws(() => applyPolicy(minimalApp({ 'big.txt': 'x'.repeat(3 * 1024 * 1024) }), { name: 'app' }), /limit/);
    const many = minimalApp(Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`src/f${i}.js`, ''])));
    assert.throws(() => applyPolicy(many, { name: 'app' }), /limit is 300/);
  });
});

describe('hardenManifest', () => {
  const harden = (pkg, warnings = []) => JSON.parse(hardenManifest(JSON.stringify(pkg), { name: 'my-app', warnings }));

  it('replaces scripts and removes everything that affects install', () => {
    const manifest = harden({
      scripts: { preinstall: 'evil', postinstall: 'evil', dev: 'evil' },
      overrides: { react: 'file:../evil' },
      resolutions: { react: 'file:../evil' },
      workspaces: ['../..'],
      bin: { x: 'y' },
      config: { registry: 'evil' },
      publishConfig: {},
      bundledDependencies: ['x'],
      main: 'evil.js',
    });
    assert.deepEqual(manifest.scripts, SCRIPTS);
    for (const key of ['overrides', 'resolutions', 'workspaces', 'bin', 'config', 'publishConfig', 'bundledDependencies', 'main']) {
      assert.equal(key in manifest, false, key);
    }
    assert.equal(manifest.private, true);
    assert.equal(manifest.type, 'module');
    assert.equal(manifest.name, 'my-app');
  });

  it('pins the core stack over whatever the model asked for', () => {
    const manifest = harden({ dependencies: { react: '^16.0.0', vite: '^1.0.0' } });
    assert.equal(manifest.dependencies.react, PINNED_DEPENDENCIES.react);
    assert.equal('vite' in manifest.dependencies, false);
    assert.match(manifest.devDependencies.vite, /^\^8/);
  });

  for (const spec of ['github:evil/x', 'git+https://evil.example/x.git', 'https://evil.example/x.tgz', 'file:../x', 'link:../x', 'npm:evil@1', 'evil/x', 'workspace:*']) {
    it(`does not honor the dependency source ${spec}`, () => {
      const warnings = [];
      assert.equal(harden({ dependencies: { lodash: spec } }, warnings).dependencies.lodash, 'latest');
      assert.equal(warnings.length, 1);
    });
  }

  it('keeps ordinary registry ranges', () => {
    for (const spec of ['^1.2.3', '~1.2', '1.x', '>=1 <3', '*', 'latest', '1.0.0-beta.1']) {
      assert.equal(harden({ dependencies: { lodash: spec } }).dependencies.lodash, spec);
    }
  });

  it('drops invalid package names', () => {
    const manifest = harden({ dependencies: { '../evil': '1.0.0', 'UPPER CASE': '1.0.0', '@scope/ok': '1.0.0' } });
    assert.equal(manifest.dependencies['@scope/ok'], '1.0.0');
    assert.equal('../evil' in manifest.dependencies, false);
    assert.equal('UPPER CASE' in manifest.dependencies, false);
  });

  it('reports bad JSON as repairable output', () => {
    assert.throws(() => hardenManifest('{nope', { name: 'x' }), OutputError);
    assert.throws(() => hardenManifest('[]', { name: 'x' }), OutputError);
  });
});

describe('findMissingPackages', () => {
  it('reports 404s, encodes scoped names, and tolerates an unreachable registry', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      if (url.includes('offline')) throw new Error('network down');
      return { status: url.includes('made-up') ? 404 : 200 };
    };
    const missing = await findMissingPackages(['real', 'made-up', '@scope/made-up', 'offline'], { fetchImpl });
    assert.deepEqual(missing, ['made-up', '@scope/made-up']);
    assert.ok(seen.some((url) => url.endsWith('/@scope%2Fmade-up')));
  });
});

describe('writer', () => {
  it('creates nested directories and writes content', async () => {
    const root = path.join(tempDir(), 'app');
    await writeProject(root, new Map([['a/b/c/d.txt', 'hello'], ['top.txt', 'x']]));
    assert.equal(readFileSync(path.join(root, 'a/b/c/d.txt'), 'utf8'), 'hello');
  });

  it('refuses a path that escapes the root even without the policy layer', async () => {
    const parent = tempDir();
    await assert.rejects(writeProject(path.join(parent, 'app'), new Map([['../evil.txt', 'x']])), /outside the project/);
    assert.equal(existsSync(path.join(parent, 'evil.txt')), false);
  });

  it('refuses to write through symlinked directories and files', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'app');
    const outside = path.join(parent, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'target.txt'), 'original');
    symlinkSync(outside, path.join(root, 'linked'));
    symlinkSync(path.join(outside, 'target.txt'), path.join(root, 'file-link.txt'));

    await assert.rejects(writeProject(root, new Map([['linked/new.txt', 'x']])), /symlink/);
    await assert.rejects(writeProject(root, new Map([['linked/deep/er/new.txt', 'x']])), /symlink/);
    await assert.rejects(writeProject(root, new Map([['file-link.txt', 'x']])), /symlink/);
    assert.equal(existsSync(path.join(outside, 'new.txt')), false);
    assert.equal(existsSync(path.join(outside, 'deep')), false);
    assert.equal(readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'original');
  });

  it('slugifies prompts into valid package names', () => {
    assert.equal(slugify('Build a collaborative to-do list'), 'collaborative-to-do-list');
    assert.equal(slugify('please create me an AI-powered recipe app for busy parents today'), 'ai-powered-recipe-app-for');
    assert.equal(slugify('日本語'), 'ignite-app');
    assert.equal(slugify('../../etc/passwd'), 'etc-passwd');
  });

  it('never picks an occupied directory on its own', () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, 'todo-app'));
    writeFileSync(path.join(cwd, 'todo-app', 'keep.txt'), 'x');
    assert.equal(resolveProjectDir('a todo app', { cwd }), path.join(cwd, 'todo-app-2'));
  });

  it('requires --force for a non-empty --dir', () => {
    const cwd = tempDir();
    mkdirSync(path.join(cwd, 'full'));
    writeFileSync(path.join(cwd, 'full', 'keep.txt'), 'x');
    assert.throws(() => resolveProjectDir('x', { cwd, dir: 'full' }), /not empty/);
    assert.equal(resolveProjectDir('x', { cwd, dir: 'full', force: true }), path.join(cwd, 'full'));
    mkdirSync(path.join(cwd, 'empty'));
    assert.equal(resolveProjectDir('x', { cwd, dir: 'empty' }), path.join(cwd, 'empty'));
  });
});

describe('childEnv', () => {
  it('removes credentials and keeps what tools need', () => {
    const env = childEnv(
      { PORT: '1234' },
      {
        PATH: '/bin',
        HOME: '/home/x',
        LANG: 'en',
        HTTPS_PROXY: 'http://proxy',
        ANTHROPIC_API_KEY: 'a',
        ANTHROPIC_BASE_URL: 'b',
        OPENAI_API_KEY: 'c',
        OPENAI_ORG_ID: 'd',
        GITHUB_TOKEN: 'e',
        AWS_SECRET_ACCESS_KEY: 'f',
        NPM_TOKEN: 'g',
        STRIPE_SECRET: 'h',
        DB_PASSWORD: 'i',
        DATABASE_URL: 'j',
        SSH_AUTH_SOCK: 'k',
      },
    );
    assert.deepEqual(env, { PATH: '/bin', HOME: '/home/x', LANG: 'en', HTTPS_PROXY: 'http://proxy', PORT: '1234' });
  });
});

describe('StepError', () => {
  for (const log of ['npm error code ENOTFOUND', 'npm error code ETIMEDOUT', 'npm error code ECONNRESET', 'npm error code ENOSPC', 'npm error code EACCES', 'npm error network request failed']) {
    it(`does not send "${log}" to the model`, () => assert.equal(new StepError('npm install', log).fixable, false));
  }

  for (const log of ['npm error code ETARGET\nNo matching version found for nanoid@^99', 'npm error code E404', 'npm error code ERESOLVE']) {
    it(`sends "${log.split('\n')[0]}" to the model`, () => assert.equal(new StepError('npm install', log).fixable, true));
  }

  it('always lets the model try build and boot failures, whatever the log says', () => {
    assert.equal(new StepError('vite build', 'EACCES in user code').fixable, true);
    assert.equal(new StepError('server boot', 'listen EACCES').fixable, true);
  });

  it('strips terminal color codes from logs', () => {
    assert.equal(new StepError('vite build', '\u001b[31mfailed\u001b[39m').log, 'failed');
  });
});

describe('normalizeError', () => {
  const anthropicError = (status, hdrs = {}, body = { error: { type: 'x', message: 'nope' } }) =>
    Anthropic.APIError.generate(status, body, 'nope', headers(hdrs));
  const openaiError = (status, body = { message: 'nope' }, hdrs = {}) => OpenAI.APIError.generate(status, body, 'nope', headers(hdrs));

  for (const [status, kind, retryable] of [
    [401, 'auth', false],
    [403, 'auth', false],
    [404, 'model', false],
    [400, 'bad_request', false],
    [413, 'bad_request', false],
    [408, 'network', true],
    [409, 'network', true],
    [429, 'rate_limit', true],
    [500, 'overloaded', true],
    [529, 'overloaded', true],
  ]) {
    it(`classifies Anthropic ${status} as ${kind}`, () => {
      const err = normalizeError(anthropicError(status));
      assert.equal(err.kind, kind);
      assert.equal(err.retryable, retryable);
    });
    it(`classifies OpenAI ${status} as ${kind}`, () => {
      const err = normalizeError(openaiError(status));
      assert.equal(err.kind, kind);
      assert.equal(err.retryable, retryable);
    });
  }

  it('does not retry an empty OpenAI balance reported as a 429', () => {
    const err = normalizeError(openaiError(429, { error: { code: 'insufficient_quota', message: 'quota' } }));
    assert.equal(err.kind, 'billing');
    assert.equal(err.retryable, false);
  });

  it('reads Retry-After in seconds, milliseconds and as a date', () => {
    assert.equal(normalizeError(anthropicError(429, { 'retry-after': '7' })).retryAfterMs, 7000);
    assert.equal(normalizeError(anthropicError(429, { 'retry-after-ms': '250' })).retryAfterMs, 250);
    const later = new Date(Date.now() + 60_000).toUTCString();
    const fromDate = normalizeError(openaiError(429, undefined, { 'retry-after': later })).retryAfterMs;
    assert.ok(fromDate > 50_000 && fromDate <= 60_000, String(fromDate));
  });

  it('surfaces the API message rather than the raw status line', () => {
    assert.equal(normalizeError(anthropicError(400, {}, { error: { type: 'x', message: 'credit balance too low' } })).message, 'credit balance too low');
  });

  it('recognizes aborts and connection failures from both SDKs', () => {
    assert.equal(normalizeError(new Anthropic.APIUserAbortError()).kind, 'abort');
    assert.equal(normalizeError(new OpenAI.APIUserAbortError()).kind, 'abort');
    assert.equal(normalizeError(new Anthropic.APIConnectionError({ message: 'x' })).retryable, true);
    assert.equal(normalizeError(new OpenAI.APIConnectionError({ message: 'x' })).retryable, true);
  });

  it('treats an API error without a status as a retryable stream failure', () => {
    const err = normalizeError(new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', undefined));
    assert.equal(err.retryable, true);
    assert.equal(err.message, 'Overloaded');
  });

  it('passes through errors from outside the SDKs', () => {
    const bug = new TypeError('a real bug');
    assert.equal(normalizeError(bug), bug);
  });
});

describe('withRetry', () => {
  const failing = (times, makeError) => {
    let calls = 0;
    const fn = async () => {
      calls += 1;
      if (calls <= times) throw makeError();
      return 'ok';
    };
    fn.calls = () => calls;
    return fn;
  };
  const rateLimited = (retryAfterMs = 0) => new ProviderError('rate_limit', 'slow down', { retryable: true, retryAfterMs });

  it('retries until success and reports each wait', async () => {
    const fn = failing(2, () => rateLimited(5));
    const seen = [];
    assert.equal(await withRetry(fn, { onRetry: (info) => seen.push(info) }), 'ok');
    assert.equal(fn.calls(), 3);
    assert.deepEqual(seen.map((info) => info.attempt), [1, 2]);
    assert.equal(seen[0].delayMs, 5);
  });

  it('gives up after the attempt limit', async () => {
    const fn = failing(99, () => rateLimited(0));
    await assert.rejects(withRetry(fn, { maxAttempts: 3 }), /slow down/);
    assert.equal(fn.calls(), 3);
  });

  it('does not retry permanent errors', async () => {
    const fn = failing(99, () => new ProviderError('auth', 'bad key'));
    await assert.rejects(withRetry(fn), /bad key/);
    assert.equal(fn.calls(), 1);
  });

  it('stops instead of waiting out a very long reset', async () => {
    const fn = failing(99, () => rateLimited(60 * 60 * 1000));
    await assert.rejects(withRetry(fn), /slow down/);
    assert.equal(fn.calls(), 1);
  });

  it('uses growing backoff with jitter when there is no Retry-After', async () => {
    const delays = [];
    const fn = failing(3, () => new ProviderError('overloaded', 'busy', { retryable: true }));
    await withRetry(fn, { baseDelayMs: 8, onRetry: ({ delayMs }) => delays.push(delayMs) });
    assert.ok(delays[0] >= 4 && delays[0] <= 8, String(delays[0]));
    assert.ok(delays[1] >= 8 && delays[1] <= 16, String(delays[1]));
    assert.ok(delays[2] >= 16 && delays[2] <= 32, String(delays[2]));
  });

  it('cancels a wait as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const fn = failing(99, () => rateLimited(60_000));
    const started = Date.now();
    const pending = withRetry(fn, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, (err) => err.kind === 'abort');
    assert.ok(Date.now() - started < 5000);
  });
});

describe('prompts', () => {
  it('states the JSON contract', () => {
    assert.match(SYSTEM_PROMPT, /single JSON object/);
    assert.match(SYSTEM_PROMPT, /relative POSIX file path/);
    assert.match(SYSTEM_PROMPT, /No Markdown, code fences/);
  });

  it('shows an example that is itself valid under the contract', () => {
    const example = SYSTEM_PROMPT.match(/^\{"package\.json".*$/m)[0];
    const files = parseFileMap(example);
    assert.deepEqual(JSON.parse(files.get('package.json')), { name: 'my-app' });
    assert.match(files.get('src/App.jsx'), /export default function App/);
  });

  it('mentions JSON in every user message, as OpenAI JSON mode requires', () => {
    const messages = [
      buildGeneratePrompt('x'),
      buildRepairPrompt({ prompt: 'x', raw: 'y', problem: 'z', truncated: false }),
      buildRepairPrompt({ prompt: 'x', raw: 'y', problem: 'z', truncated: true }),
      buildFixPrompt({ prompt: 'x', files: new Map([['a', 'b']]), stage: 'build', log: 'err' }),
    ];
    messages.forEach((message) => assert.match(message, /JSON/));
  });

  it('keeps the end of a long failure log, where errors usually are', () => {
    const log = `start${'x'.repeat(20_000)}THE_ACTUAL_ERROR`;
    const prompt = buildFixPrompt({ prompt: 'x', files: new Map(), stage: 'build', log });
    assert.match(prompt, /THE_ACTUAL_ERROR/);
    assert.ok(prompt.length < 10_000);
  });
});
