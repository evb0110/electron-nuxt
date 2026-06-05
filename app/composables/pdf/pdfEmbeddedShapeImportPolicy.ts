export const EMBEDDED_SHAPE_IMPORT_INITIAL_RENDER_MAX_BYTES = 8 * 1024 * 1024;

export function resolveEmbeddedShapeImportLoadPolicy(
    sourceData: Uint8Array | null | undefined,
    workingCopyPath: string | null | undefined,
) {
    const hasSourceData = sourceData instanceof Uint8Array && sourceData.byteLength > 0;
    const hasWorkingCopyPath = typeof workingCopyPath === 'string' && workingCopyPath.trim().length > 0;

    if (hasSourceData) {
        if (sourceData.byteLength > EMBEDDED_SHAPE_IMPORT_INITIAL_RENDER_MAX_BYTES) {
            return {
                awaitBeforeInitialRender: false,
                deferUntilAfterInitialRender: true,
            };
        }

        return {
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        };
    }

    if (hasWorkingCopyPath) {
        return {
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        };
    }

    return {
        awaitBeforeInitialRender: true,
        deferUntilAfterInitialRender: false,
    };
}
