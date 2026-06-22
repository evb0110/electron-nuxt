import { embeddedShapeImportInitialRenderMaxBytes } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-import-policy/embeddedShapeImportInitialRenderMaxBytes';

interface IEmbeddedShapeImportLoadPolicy {
    awaitBeforeInitialRender: boolean;
    deferUntilAfterInitialRender: boolean;
    skipAutomaticImport?: true;
}

export function resolveEmbeddedShapeImportLoadPolicy(
    sourceData: Uint8Array | null | undefined,
    workingCopyPath: string | null | undefined,
    sourceFileSize?: number | null,
): IEmbeddedShapeImportLoadPolicy {
    const hasSourceData = sourceData instanceof Uint8Array && sourceData.byteLength > 0;
    const hasWorkingCopyPath = typeof workingCopyPath === 'string' && workingCopyPath.trim().length > 0;

    if (hasSourceData) {
        if (sourceData.byteLength > embeddedShapeImportInitialRenderMaxBytes) {
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
        if (
            typeof sourceFileSize === 'number'
            && sourceFileSize > embeddedShapeImportInitialRenderMaxBytes
        ) {
            return {
                awaitBeforeInitialRender: false,
                deferUntilAfterInitialRender: false,
                skipAutomaticImport: true,
            };
        }

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
