export interface IEmbeddedShapeImportLoadPolicy {
    awaitBeforeInitialRender: boolean;
    deferUntilAfterInitialRender: boolean;
}

export function resolveEmbeddedShapeImportLoadPolicy(
    sourceData: Uint8Array | null | undefined,
    workingCopyPath: string | null | undefined,
): IEmbeddedShapeImportLoadPolicy {
    const hasSourceData = sourceData instanceof Uint8Array && sourceData.byteLength > 0;
    const hasWorkingCopyPath = typeof workingCopyPath === 'string' && workingCopyPath.trim().length > 0;

    if (hasSourceData) {
        return {
            awaitBeforeInitialRender: true,
            deferUntilAfterInitialRender: false,
        };
    }

    if (hasWorkingCopyPath) {
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
