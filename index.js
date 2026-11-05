#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';
import { Command, InvalidArgumentError, Option } from 'commander';
import pc from 'picocolors';

import { fixApp, generateApp } from './src/chain.js';
import {
  StepError,
  buildApp,
  checkServerBoots,
  getFreePort,
  installDependencies,
  killRunning,
  openBrowser,
  startDevServer,
} from './src/executor.js';
import { extraPackages, findMissingPackages } from './src/policy.js';
import { DEFAULT_EFFORT, DEFAULT_MAX_TOKENS, DEFAULT_MODELS, ProviderError, createLLM } from './src/providers.js';
import { resolveProjectDir, slugify, writeProject } from './src/writer.js';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const MIN_NODE = [22, 12];
const isTTY = Boolean(process.stdout.isTTY);

// Some CI and Docker pseudo-terminals report a width of 0, which makes clack wrap after every character.
if (isTTY && !process.stdout.columns) process.stdout.columns = 80;

const seconds = (ms) => `${Math.round(ms / 1000)}s`;
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function exitCancelled() {
  p.cancel('Cancelled.');
  process.exit(130);
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
    throw new Error(`Ignite needs Node ${MIN_NODE.join('.')} or newer, because the generated app's tools require it. You have ${process.versions.node}.`);
  }
}

async function resolvePrompt(words) {
  const fromArgs = words.join(' ').trim();
  if (fromArgs) return fromArgs;
  if (!process.stdin.isTTY) throw new Error('Describe your app, for example: ignite "Build a collaborative to-do list"');

  const answer = await p.text({
    message: 'What do you want to build?',
    placeholder: 'A collaborative to-do list',
    validate: (value) => (value?.trim() ? undefined : 'Describe the app in a few words.'),
  });
  if (p.isCancel(answer)) exitCancelled();
  return answer.trim();
}

/** Picks a provider and key. A key typed at the prompt lasts for this run and is never saved. */
async function resolveCredentials(requested) {
  const available = {
    anthropic: Boolean(
      process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || existsSync(path.join(homedir(), '.config', 'anthropic')),
    ),
    openai: Boolean(process.env.OPENAI_API_KEY),
  };

  if (requested && available[requested]) return { provider: requested };
  if (!requested && available.anthropic) return { provider: 'anthropic' };
  if (!requested && available.openai) return { provider: 'openai' };

  if (!process.stdin.isTTY) {
    throw new Error('No API key found. Set ANTHROPIC_API_KEY or OPENAI_API_KEY and run again.');
  }

  let provider = requested;
  if (!provider) {
    provider = await p.select({
      message: 'Which API do you want to use? No API key was found in your environment.',
      options: [
        { value: 'anthropic', label: 'Anthropic', hint: DEFAULT_MODELS.anthropic },
        { value: 'openai', label: 'OpenAI', hint: DEFAULT_MODELS.openai },
      ],
    });
    if (p.isCancel(provider)) exitCancelled();
  }

  const envName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  const apiKey = await p.password({
    message: `Paste your API key. It is used for this run only; export ${envName} to skip this step.`,
    validate: (value) => (value?.trim() ? undefined : 'The API key cannot be empty.'),
  });
  if (p.isCancel(apiKey)) exitCancelled();
  return { provider, apiKey: apiKey.trim() };
}

// clack's spinner puts the terminal in raw mode, so Ctrl-C arrives as a keypress and
// clack calls process.exit(0) without raising SIGINT. This is how the exit handler
// tells that apart from a normal finish and reports the cancel to the shell.
let spinnerRunning = false;

/** clack animates even when output is piped, which would fill CI logs with spinner frames. */
function createSpinner() {
  if (isTTY) return p.spinner();
  return {
    start: (message) => p.log.step(message),
    message() {},
    stop: (message) => p.log.success(message),
    error: (message) => p.log.error(message),
  };
}

/** Wraps one LLM step in a spinner showing the current file, the file count and elapsed time. */
async function llmStep(label, run) {
  const spinner = createSpinner();
  const started = Date.now();
  let currentFile = null;
  let count = 0;
  let status = null; // Temporary text, such as a rate-limit wait, replaces the file readout.

  const render = () => {
    const detail = status ?? (currentFile ? `${currentFile} ${pc.dim(`(file ${count})`)}` : pc.dim('thinking'));
    spinner.message(`${label} ${pc.dim('·')} ${detail} ${pc.dim(seconds(Date.now() - started))}`);
  };

  spinner.start(label);
  spinnerRunning = true;
  const timer = isTTY ? setInterval(render, 1000) : null;

  const ui = {
    onFile(file) {
      currentFile = file;
      count += 1;
      status = null;
      if (isTTY) render();
    },
    onReset() {
      currentFile = null;
      count = 0;
    },
    onRetry({ kind, delayMs, attempt, maxAttempts }) {
      const reason = kind === 'rate_limit' ? 'Rate limited' : 'API hiccup';
      status = pc.yellow(`${reason}, retrying in ${seconds(delayMs)} (${attempt}/${maxAttempts - 1})`);
      if (isTTY) render();
      else p.log.warn(status);
    },
    onRepair(problem) {
      status = pc.yellow('Output was not usable, asking the model to correct it');
      if (isTTY) render();
      else p.log.warn(`Repairing model output: ${problem}`);
    },
  };

  try {
    const result = await run(ui);
    spinner.stop(`${label} ${pc.dim(`done in ${seconds(Date.now() - started)}`)}`);
    return result;
  } catch (err) {
    spinner.error(`${label} failed`);
    throw err;
  } finally {
    spinnerRunning = false;
    if (timer) clearInterval(timer);
  }
}

async function shellStep(label, run) {
  const spinner = createSpinner();
  const started = Date.now();
  spinner.start(label);
  spinnerRunning = true;
  try {
    const result = await run();
    spinner.stop(`${label} ${pc.dim(`done in ${seconds(Date.now() - started)}`)}`);
    return result;
  } catch (err) {
    spinner.error(`${label} failed`);
    throw err;
  } finally {
    spinnerRunning = false;
  }
}

function showFiles(files) {
  const names = [...files.keys()].sort();
  const shown = names.slice(0, 24).map((name) => `${pc.green('+')} ${name}`);
  if (names.length > shown.length) shown.push(pc.dim(`...and ${names.length - shown.length} more`));
  p.note(shown.join('\n'), `${names.length} files`);
}

const showWarnings = (warnings) => warnings.forEach((warning) => p.log.warn(warning));

/** Installs and checks the project, feeding failures back to the model until it passes or the budget runs out. */
async function buildUntilHealthy({ llm, prompt, name, root, files, maxFixes, signal }) {
  let needsInstall = true;

  for (let fix = 0; ; fix += 1) {
    try {
      if (needsInstall) {
        const extras = extraPackages(files.get('package.json'));
        if (extras.length > 0) {
          p.log.info(`Packages chosen by the model: ${extras.join(', ')}`);
          const missing = await findMissingPackages(extras);
          if (missing.length > 0) {
            throw new StepError('dependency check', `These packages do not exist on npm: ${missing.join(', ')}. Remove them or use real packages.`);
          }
        }
        await shellStep('Installing dependencies', () => installDependencies(root));
        needsInstall = false;
      }
      await shellStep('Building the frontend', () => buildApp(root));
      await shellStep('Booting the API server', () => checkServerBoots(root));
      return;
    } catch (err) {
      if (!(err instanceof StepError)) throw err;
      if (!err.fixable) {
        p.log.error(err.log.split('\n').slice(-25).join('\n'));
        throw new Error(`npm install hit a network or disk problem, which is not caused by the app's code. The files are in ${root}. Once that is resolved, run npm install --ignore-scripts there.`);
      }
      if (fix >= maxFixes) {
        p.log.error(err.log.split('\n').slice(-25).join('\n'));
        throw new Error(`The app still fails at the "${err.stage}" stage after ${maxFixes} automatic fix${maxFixes === 1 ? '' : 'es'}. The files are in ${root}.`);
      }

      p.log.warn(`The ${err.stage} step failed. Asking the model for a fix (${fix + 1}/${maxFixes}).`);
      const failure = { stage: err.stage, log: err.log };
      const { files: changed, warnings } = await llmStep('Fixing the app', (ui) =>
        fixApp({ llm, prompt, name, files, failure, ui, signal }),
      );
      showWarnings(warnings);

      if (changed.has('package.json') && changed.get('package.json') !== files.get('package.json')) needsInstall = true;
      for (const [file, content] of changed) files.set(file, content);
      await writeProject(root, changed);
      p.log.info(`Updated ${[...changed.keys()].join(', ')}`);
    }
  }
}

function usageLine(llm) {
  return `${llm.model}: ${compact(llm.usage.input)} input and ${compact(llm.usage.output)} output tokens`;
}

async function runDevServer({ root, llm, open }) {
  const relative = path.relative(process.cwd(), root) || '.';
  const { child, exited } = startDevServer(root, {
    apiPort: await getFreePort(),
    onReady(url) {
      p.note(`${pc.bold(pc.green(url))}\n${pc.dim(`Project: ${relative}`)}\n${pc.dim('Press Ctrl-C to stop.')}`, 'Your app is live');
      if (open) openBrowser(url);
    },
  });

  // A terminal Ctrl-C reaches the whole process group on its own. Forwarding also
  // covers a signal sent to this process alone, as a supervisor would do.
  let stopping = false;
  const stop = (signal) => {
    stopping = true;
    child.kill(signal);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const { code, error } = await exited;
  if (error) throw new Error(`Could not start the dev server: ${error.message}`);
  if (stopping) {
    p.outro(`Stopped. Restart it with ${pc.cyan(`cd ${relative} && npm run dev`)}`);
    process.exitCode = 0;
    return;
  }
  throw new Error(`The dev server exited with code ${code}. Run it yourself with: cd ${relative} && npm run dev`);
}

async function main(words, options) {
  p.intro(`${pc.bgYellow(pc.black(' ignite '))} ${pc.dim(`v${version}`)}`);
  assertNodeVersion();

  const prompt = await resolvePrompt(words);
  const credentials = await resolveCredentials(options.provider);
  const root = resolveProjectDir(prompt, options); // Runs first, so a bad path never costs tokens.
  const name = slugify(path.basename(root));

  const llm = createLLM({
    ...credentials,
    model: options.model,
    maxTokens: options.maxTokens,
    effort: options.effort,
  });

  const abort = new AbortController();
  const cancel = () => {
    abort.abort();
    killRunning();
    exitCancelled();
  };
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  process.on('exit', () => {
    killRunning();
    if (spinnerRunning && !process.exitCode) process.exitCode = 130;
  });

  p.log.step(`Building ${pc.cyan(prompt)} with ${pc.dim(llm.model)}`);

  const { files, warnings } = await llmStep('Writing your app', (ui) =>
    generateApp({ llm, prompt, name, ui, signal: abort.signal }),
  );
  showWarnings(warnings);

  await writeProject(root, files);
  showFiles(files);

  const relative = path.relative(process.cwd(), root) || '.';
  if (!options.install) {
    p.log.info(usageLine(llm));
    p.outro(`Files written. Next: ${pc.cyan(`cd ${relative} && npm install --ignore-scripts && npm run dev`)}`);
    return;
  }

  await buildUntilHealthy({ llm, prompt, name, root, files, maxFixes: options.maxFixes, signal: abort.signal });
  p.log.info(usageLine(llm));

  if (!options.start) {
    p.outro(`Ready. Start it with ${pc.cyan(`cd ${relative} && npm run dev`)}`);
    return;
  }

  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
  p.log.warn('Starting code written by an AI model, with your user permissions. Ctrl-C stops it.');
  await runDevServer({ root, llm, open: options.open });
}

function parsePositiveInt(min) {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min) throw new InvalidArgumentError(`Must be a whole number of at least ${min}.`);
    return parsed;
  };
}

const program = new Command()
  .name('ignite')
  .description('Type one sentence. Get a running full-stack React app.')
  .version(version)
  .argument('[prompt...]', 'what to build')
  .addOption(new Option('-p, --provider <name>', 'LLM provider (default: whichever API key is set)').choices(['anthropic', 'openai']).env('IGNITE_PROVIDER'))
  .addOption(new Option('-m, --model <id>', `model id (default: ${DEFAULT_MODELS.anthropic} or ${DEFAULT_MODELS.openai})`).env('IGNITE_MODEL'))
  .addOption(new Option('-e, --effort <level>', 'how hard the model works').choices(['low', 'medium', 'high', 'xhigh', 'max']).default(DEFAULT_EFFORT))
  .addOption(new Option('--max-tokens <n>', 'output limit for each model response').argParser(parsePositiveInt(1024)).default(DEFAULT_MAX_TOKENS))
  .addOption(new Option('--max-fixes <n>', 'automatic fix rounds when a check fails').argParser(parsePositiveInt(0)).default(2))
  .option('-d, --dir <path>', 'project directory (default: derived from the prompt)')
  .option('--force', 'write into a non-empty --dir, overwriting files with the same names')
  .option('--no-install', 'write the files and stop')
  .option('--no-start', 'install and check, but do not start the dev server')
  .option('--open', 'open the app in your browser when it is ready')
  .action(main);

try {
  await program.parseAsync();
} catch (err) {
  if (err instanceof ProviderError && err.kind === 'abort') exitCancelled();
  p.log.error(err.message);
  if (err instanceof ProviderError && err.hint) p.log.info(err.hint);
  p.outro(pc.red('Ignite stopped.'));
  process.exitCode = 1;
}
