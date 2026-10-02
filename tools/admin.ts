#!/usr/bin/env -S npx tsx
/**
 * genome-portal admin CLI entry point. Run from the repository root:
 *
 *   npm run admin -- org create --id KU-lab --name "KU lab"
 *   npm run admin -- location assign --org KU-lab --bucket <data-bucket> --prefix projects/P2026-0412/
 *   npm run admin -- audit export --from 2026-10-01 --to 2026-10-31 --out audit.csv
 *
 * Config: tools/admin.config.json (copy admin.config.example.json) or --config <path>.
 * Token cache: ~/.genome-portal/token.json (0600). Use --login to force a fresh sign-in.
 */
import { AdminApiError } from './src/api.js';
import { buildProgram } from './src/cli.js';
import { handlers } from './src/handlers.js';

const program = buildProgram(handlers);

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof AdminApiError) {
    console.error(err.message);
    process.exit(err.status === 401 ? 3 : 2);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
