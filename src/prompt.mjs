// Terminal prompt abstraction used by the interactive wizard and confirmations.
//
// The wizard talks to an `io` object with `write(text)`, `question(prompt)` and `close()`.
// `createConsoleIo` wraps readline on the real terminal; `createScriptedIo` replays a list of
// answers and records a transcript so the wizard can be tested without a TTY.
import readline from 'node:readline/promises';
import { PlatformError } from './utils.mjs';

export function createConsoleIo({ input = process.stdin, output = process.stdout } = {}) {
  let rl = null;
  return {
    isInteractive: Boolean(input.isTTY),
    write(text) { output.write(text); },
    async question(prompt) {
      if (!rl) rl = readline.createInterface({ input, output });
      try {
        return (await rl.question(prompt)).trim();
      } catch (err) {
        // Ctrl-D / closed stdin: treat as an abort rather than a stack trace.
        throw new PlatformError('Input closed; wizard aborted.', { code: 'ABORTED', cause: err });
      }
    },
    close() { if (rl) { rl.close(); rl = null; } },
  };
}

export function createScriptedIo(answers = []) {
  const queue = [...answers];
  const transcript = [];
  return {
    isInteractive: true,
    transcript,
    queue,
    get text() { return transcript.join(''); },
    write(text) { transcript.push(String(text)); },
    async question(prompt) {
      transcript.push(prompt);
      if (!queue.length) throw new PlatformError(`Scripted input exhausted at prompt "${prompt.trim()}".`, { code: 'NO_INPUT' });
      const answer = String(queue.shift());
      transcript.push(`${answer}\n`);
      return answer.trim();
    },
    close() {},
  };
}
