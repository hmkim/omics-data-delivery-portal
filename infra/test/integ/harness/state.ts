import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { inject } from 'vitest';
import { runDir } from './paths';

/** Run id provided by harness/global-setup.ts; `INTEG_RUN_ID` overrides it for ad-hoc single-file runs. */
export function runId(): string {
  return process.env['INTEG_RUN_ID'] ?? inject('runId');
}

function stateDir(): string {
  const dir = runDir(runId());
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface FirstDownload {
  downloadId: string;
  bucket: string;
  key: string;
  userSub: string;
  issuedAt: string;
}

const FIRST_DOWNLOAD_FILE = 'first-download.json';

/** Remember the first successful `POST /downloads` of this run (T6.7 looks it up in CloudTrail). */
export function recordFirstDownload(d: FirstDownload): void {
  const file = path.join(stateDir(), FIRST_DOWNLOAD_FILE);
  if (existsSync(file)) return;
  writeFileSync(file, JSON.stringify(d, null, 2));
}

export function readFirstDownload(): FirstDownload | undefined {
  const file = path.join(stateDir(), FIRST_DOWNLOAD_FILE);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as FirstDownload;
}

/** Evidence lines: printed and appended to `<stateDir>/evidence.log` for the acceptance record. */
export function evidence(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.info(`[evidence] ${stamped}`);
  appendFileSync(path.join(stateDir(), 'evidence.log'), `${stamped}\n`);
}
