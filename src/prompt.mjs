// Terminal questions for `raytrace setup`. Secrets are read with echo off so
// an API key never lands in the scrollback.
import { createInterface } from 'node:readline/promises';

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export async function ask(question, fallback = '') {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim() || fallback; } finally { rl.close(); }
}

export async function confirm(question, fallback = true) {
  const answer = (await ask(`${question} ${fallback ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
  return answer ? answer.startsWith('y') : fallback;
}

export function askSecret(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    let value = '';
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (error) reject(error); else resolve(value.trim());
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('Cancelled.')); // Ctrl-C
        if (char === '\u007f' || char === '\b') { if (value) { value = value.slice(0, -1); stdout.write('\b \b'); } continue; }
        if (char >= ' ') { value += char; stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}
