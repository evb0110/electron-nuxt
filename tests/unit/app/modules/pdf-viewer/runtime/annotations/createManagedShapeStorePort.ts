import { vi } from 'vitest';
import type { IManagedEmbeddedPdfShapeProjectionPort } from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';

/**
 * Stands in for the canonical projection: it records the intents the composable
 * forwards, and never decides an import mode of its own.
 *
 * `skipRerender` belongs to the plan the stub import returns, so it is a
 * parameter rather than an override: suites that never repaint pin it to `true`
 * instead of restating the whole plan.
 */
export function createManagedShapeStorePort(
    overrides: Partial<IManagedEmbeddedPdfShapeProjectionPort> = {},
    {skipRerender = false}: {skipRerender?: boolean} = {},
): IManagedEmbeddedPdfShapeProjectionPort {
    let baselineReady = false;
    return {
        getAllShapes: () => [],
        getDeletedEmbeddedAnnotationIds: () => [],
        getDeletedEmbeddedShapeStableKeys: () => [],
        importEmbeddedShapes: vi.fn(() => {
            baselineReady = true;
            return {
                mode: 'replace' as const,
                skipRerender,
                reason: 'stub-import',
            };
        }),
        resetShapeImportBaseline: vi.fn(() => {
            baselineReady = false;
        }),
        isShapeImportBaselineReady: () => baselineReady,
        preservesShapeImportBaseline: () => baselineReady,
        clearPendingShapeImportAdoption: vi.fn(),
        beginShapeSave: () => ({
            primePersistedShapes: vi.fn(() => true),
            rollback: vi.fn(() => true),
            markSaved: vi.fn(() => true),
        }),
        ...overrides,
    };
}
