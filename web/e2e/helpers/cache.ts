import { readFileSync } from 'node:fs';
import { athenaQuery, cacheResultTypesSql, type AthenaRow } from './aws';

export interface CachePass {
  downloadId: string;
  path: 'S3' | 'CF';
  startedAt: string;
  completedAt: string;
  url: string;
}

export interface CachePassesFile {
  object: string;
  uriStem: string;
  passes: CachePass[];
}

export function readCachePasses(file: string): CachePassesFile {
  return JSON.parse(readFileSync(file, 'utf8')) as CachePassesFile;
}

export interface SecondPassResult {
  sql: string;
  rows: AthenaRow[];
  byType: Record<string, number>;
  misses: AthenaRow[];
}

/**
 * Athena check for R5.8: every request of the SECOND CloudFront pass must be `x_edge_result_type = 'Hit'`.
 * Polls (logs arrive 5–60 min after the requests) until rows exist or `waitMinutes` elapse.
 */
export async function checkSecondPassHits(
  record: CachePassesFile,
  waitMinutes: number,
  log: (line: string) => void = console.log,
): Promise<SecondPassResult> {
  const cf = record.passes.filter((p) => p.path === 'CF');
  if (cf.length < 2) throw new Error(`need two CloudFront passes, found ${cf.length}`);
  const second = cf[1]!;
  const from = new Date(new Date(second.startedAt).getTime() - 60_000);
  const to = new Date(new Date(second.completedAt).getTime() + 60_000);
  const sql = cacheResultTypesSql(record.uriStem, from, to);
  log(sql);
  const deadline = Date.now() + waitMinutes * 60_000;
  let rows = await athenaQuery(sql);
  while (rows.length === 0 && Date.now() < deadline) {
    log(
      `no log rows yet for ${record.uriStem} ${second.startedAt}..${second.completedAt}; retrying in 2 min`,
    );
    await new Promise((r) => setTimeout(r, 120_000));
    rows = await athenaQuery(sql);
  }
  const byType: Record<string, number> = {};
  for (const r of rows) byType[r.x_edge_result_type ?? ''] = (byType[r.x_edge_result_type ?? ''] ?? 0) + 1;
  const misses = rows.filter((r) => r.x_edge_result_type !== 'Hit');
  return { sql, rows, byType, misses };
}
