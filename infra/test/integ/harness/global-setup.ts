import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import { runDir } from './paths';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Short id shared by every integ file of one `INTEG=1 npm test -w infra` invocation. */
    runId: string;
  }
}

/**
 * One run id per vitest invocation. Test files run in separate module contexts, so the id is handed over with
 * `provide()` and the per-run state (first downloadId, timing lines) lives under `$PORTAL_SCRATCH/gp/integ/`.
 */
export default function setup(project: TestProject): void {
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${randomBytes(3).toString('hex')}`;
  const dir = runDir(runId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  project.provide('runId', runId);
  console.info(`[integ] runId=${runId} stateDir=${dir}`);
}
