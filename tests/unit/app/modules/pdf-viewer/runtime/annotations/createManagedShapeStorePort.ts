import type { IManagedEmbeddedPdfShapeProjectionPort } from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';

/**
 * Stands in for the canonical projection used by the rendering adapter.
 */
export function createManagedShapeStorePort(
    overrides: Partial<IManagedEmbeddedPdfShapeProjectionPort> = {},
): IManagedEmbeddedPdfShapeProjectionPort {
    return {
        getAllShapes: () => [],
        getDeletedEmbeddedAnnotationIds: () => [],
        getDeletedEmbeddedShapeStableKeys: () => [],
        ...overrides,
    };
}
