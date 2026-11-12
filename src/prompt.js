// The few questions `zenextia init` asks a person at a terminal. An agent, a
// pipe or --yes never sees them: the options and their defaults apply.

import readline from 'node:readline/promises';

/** Ask on a TTY. `answers` replaces the terminal in tests. */
export function createAsker({ input, output, answers } = {}) {
  if (answers) {
    const queue = [...answers];
    return { ask: async () => queue.shift() ?? '', close() {} };
  }
  const rl = readline.createInterface({ input, output });
  return { ask: (question) => rl.question(question), close: () => rl.close() };
}

/** A numbered choice; Enter keeps the default. */
export async function choose(asker, output, question, choices, defaultValue) {
  output.write(`\n${question}\n`);
  choices.forEach((choice, index) => {
    output.write(`  ${index + 1}. ${choice.label}${choice.value === defaultValue ? ' (par défaut)' : ''}\n`);
  });
  for (;;) {
    const answer = (await asker.ask('> ')).trim();
    if (!answer) return defaultValue;
    const picked = choices[Number(answer) - 1] ?? choices.find((choice) => choice.value === answer);
    if (picked) return picked.value;
    output.write(`Répondez par un numéro entre 1 et ${choices.length}.\n`);
  }
}

/** Free text; Enter keeps the default. */
export async function text(asker, output, question, defaultValue = '') {
  const answer = (await asker.ask(`\n${question}${defaultValue ? ` [${defaultValue}]` : ''}\n> `)).trim();
  return answer || defaultValue;
}
