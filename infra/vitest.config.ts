import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

const integ = process.env.INTEG === '1';

/** Integration files run one after another in path order (t6.1 harness first, t6.8 performance last). */
class PathOrderSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    return files;
  }
}

export default defineConfig({
  test: {
    include: integ ? ['test/integ/**/*.test.ts'] : ['test/unit/**/*.test.ts'],
    testTimeout: integ ? 600_000 : 10_000,
    hookTimeout: integ ? 600_000 : 10_000,
    ...(integ
      ? {
          fileParallelism: false,
          maxConcurrency: 1,
          globalSetup: ['test/integ/harness/global-setup.ts'],
          sequence: { sequencer: PathOrderSequencer, concurrent: false, shuffle: false },
          reporters: ['verbose'],
        }
      : {}),
    coverage: {
      provider: 'v8',
      include: ['lambda/**/*.ts'],
      exclude: ['lambda/**/*.d.ts'],
      thresholds: { lines: 80 },
    },
  },
});
