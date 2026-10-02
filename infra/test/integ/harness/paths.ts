import { tmpdir } from 'node:os';
import path from 'node:path';

/** `$PORTAL_SCRATCH/gp/integ` (falls back to the OS temp dir); run logs and per-run state live here. */
export function integScratchDir(): string {
  const base = process.env['PORTAL_SCRATCH'] ?? process.env['TMPDIR'] ?? tmpdir();
  return path.join(base, 'gp', 'integ');
}

export function runDir(runId: string): string {
  return path.join(integScratchDir(), `run-${runId}`);
}
