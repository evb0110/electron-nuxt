import { defineConfig } from 'vitest/config';
import { vitestResolveAlias } from './scripts/vitestResolveAlias';

const includeExtendedDrawShapeLifecycle = process.env.EVB_E2E_DRAW_SHAPES_EXTENDED === '1';
const includeLargePdfAnnotationSave = process.env.EVB_E2E_LARGE_PDF === '1';
const includeRapidPdfNavigation = process.env.EVB_E2E_RAPID_PDF_NAVIGATION === '1';
const includePdfSkeletonNavigationDiagnostics = process.env.EVB_E2E_PDF_SKELETON_NAVIGATION_DIAGNOSTICS === '1';
const includeArnoldPdfOpenDiagnostics = process.env.EVB_E2E_ARNOLD_PDF_OPEN_DIAGNOSTICS === '1';

export default defineConfig({
    resolve: {alias: vitestResolveAlias},
    test: {
        // Keep smoke focused on deterministic startup coverage.
        // Set EVB_E2E_DRAW_SHAPES_EXTENDED=1 to run the full draw lifecycle matrix.
        include: [
            'tests/e2e/electron/startupHydration.e2e.test.ts',
            'tests/e2e/electron/recentFiles.e2e.test.ts',
            'tests/e2e/electron/viewerSmoke.e2e.test.ts',
            'tests/e2e/electron/inactivePdfTabs.e2e.test.ts',
            'tests/e2e/electron/inactiveDjvuTabs.e2e.test.ts',
            'tests/e2e/electron/annotationLifecycle.e2e.test.ts',
            'tests/e2e/electron/squigglyMarkup.e2e.test.ts',
            ...(includeExtendedDrawShapeLifecycle
                ? ['tests/e2e/electron/drawShapeLifecycle.e2e.test.ts']
                : []),
            ...(includeLargePdfAnnotationSave
                ? ['tests/e2e/electron/largePdfAnnotationSave.e2e.test.ts']
                : []),
            ...(includeRapidPdfNavigation
                ? ['tests/e2e/electron/rapidPdfNavigation.e2e.test.ts']
                : []),
            ...(includePdfSkeletonNavigationDiagnostics
                ? ['tests/e2e/electron/pdfSkeletonNavigationDiagnostics.e2e.test.ts']
                : []),
            ...(includeArnoldPdfOpenDiagnostics
                ? ['tests/e2e/electron/arnoldPdfOpenDiagnostics.e2e.test.ts']
                : []),
        ],
        globals: false,
        fileParallelism: false,
        maxWorkers: 1,
        reporters: ['verbose'],
        retry: 0,
        testTimeout: 90_000,
        hookTimeout: 150_000,
        teardownTimeout: 30_000,
        sequence: { concurrent: false },
    },
});
