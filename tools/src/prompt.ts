/** Minimal terminal prompts (no extra dependency). Hidden input works on a TTY; otherwise it falls back to plain input. */
import { createInterface } from 'node:readline';

/**
 * Non-TTY input (a here-doc, a file, a pipe): stdin is read once into a queue and every prompt takes the
 * next line. Creating a fresh readline interface per prompt loses the lines already buffered by the previous
 * one and then waits forever on EOF, which made the CLI exit silently with no result.
 */
let pipedLines: Promise<string[]> | undefined;

function readAllPipedLines(): Promise<string[]> {
  if (!pipedLines) {
    pipedLines = new Promise((resolve) => {
      const lines: string[] = [];
      const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on('line', (line) => lines.push(line));
      rl.on('close', () => resolve(lines));
    });
  }
  return pipedLines;
}

async function nextPipedLine(question: string): Promise<string> {
  process.stderr.write(question);
  const lines = await readAllPipedLines();
  if (lines.length === 0) {
    process.stderr.write('\n');
    throw new Error(`no more input on stdin for prompt "${question.trim()}" (stdin is not a terminal)`);
  }
  process.stderr.write('\n');
  return lines.shift() as string;
}

export function promptLine(question: string): Promise<string> {
  if (!process.stdin.isTTY) return nextPipedLine(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    return promptLine(question);
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          cleanup();
          process.stderr.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new Error('interrupted'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}
