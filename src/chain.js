// The prompt chain. Each step is a fresh single-turn request carrying its full
// context, so the flow behaves the same on both providers and a fix round always
// works from the files as they currently stand.

import { OutputError, createKeyTracker, parseFileMap } from './parse.js';
import { applyPolicy } from './policy.js';
import { SYSTEM_PROMPT, buildFixPrompt, buildGeneratePrompt, buildRepairPrompt } from './prompts.js';

const MAX_REPAIRS = 2;

/** Sends a message and returns policy-approved files, repairing unusable output along the way. */
async function requestFiles({ llm, prompt, name, firstMessage, partial, ui, signal }) {
  let user = firstMessage;

  for (let repair = 0; ; repair += 1) {
    const tracker = createKeyTracker(ui.onFile);
    const { text, truncated } = await llm.complete({
      system: SYSTEM_PROMPT,
      user,
      signal,
      onText: (delta) => tracker.push(delta),
      onAttempt: () => {
        tracker.reset();
        ui.onReset();
      },
      onRetry: ui.onRetry,
    });

    try {
      if (truncated) throw new OutputError('The response hit the output limit.', { truncated: true });
      return applyPolicy(parseFileMap(text), { name, partial });
    } catch (err) {
      if (!(err instanceof OutputError)) throw err;
      if (repair >= MAX_REPAIRS) {
        throw new Error(`The model did not produce usable output after ${MAX_REPAIRS + 1} tries. Last problem: ${err.message}`);
      }
      ui.onRepair(err.message);
      user = buildRepairPrompt({ prompt, raw: text, problem: err.message, truncated: err.truncated, partial });
    }
  }
}

export function generateApp({ llm, prompt, name, ui, signal }) {
  return requestFiles({
    llm,
    prompt,
    name,
    firstMessage: buildGeneratePrompt(prompt),
    partial: false,
    ui,
    signal,
  });
}

export function fixApp({ llm, prompt, name, files, failure, ui, signal }) {
  return requestFiles({
    llm,
    prompt,
    name,
    firstMessage: buildFixPrompt({ prompt, files, stage: failure.stage, log: failure.log }),
    partial: true,
    ui,
    signal,
  });
}
