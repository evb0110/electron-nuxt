import { defineConfig } from 'vitest/config';

const includeExtendedDrawShapeLifecycle = process.env.EVB_E2E_DRAW_SHAPES_EXTENDED === '1';
const includeLargePdfAnnotationSave = process.env.EVB_E2E_LARGE_PDF === '1';

export default defineConfig({ test: {
    // Keep smoke focused on deterministic startup coverage.
    // Set EVB_E2E_DRAW_SHAPES_EXTENDED=1 to run the full draw lifecycle matrix.
    include: [
        'tests/e2e/electron/phase0StartupHydration.e2e.test.ts',
        'tests/e2e/electron/phase0ViewerSmoke.e2e.test.ts',
        'tests/e2e/electron/phase1AnnotationLifecycle.e2e.test.ts',
        ...(includeExtendedDrawShapeLifecycle
            ? ['tests/e2e/electron/phase1DrawShapeLifecycle.e2e.test.ts']
            : []),
        ...(includeLargePdfAnnotationSave
            ? ['tests/e2e/electron/phase1LargePdfAnnotationSave.e2e.test.ts']
            : []),
    ],
    globals: false,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    retry: 0,
    testTimeout: 240_000,
    hookTimeout: 300_000,
    sequence: { concurrent: false },
} });
