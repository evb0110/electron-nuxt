/* eslint-disable custom/file-naming -- Compatibility entrypoint preserves the existing Electron import path. */
import {runNativeToolCommand} from '@electron/native-tools/runNativeToolCommand';
import {
    parsePdfInfoPageGeometry,
    parsePdfPageSizesPayload,
    readPdfPageSizes as readCorePdfPageSizes,
    type IPdfPageSize,
} from '@scan-cleanup-core/pdfPageSizes';
import type {IReadPdfPageSizesOptions as ICoreReadPdfPageSizesOptions} from '@scan-cleanup-core/types';

export type {IPdfPageSize};
export {
    parsePdfInfoPageGeometry, parsePdfPageSizesPayload,
};

export interface IReadPdfPageSizesOptions extends Omit<ICoreReadPdfPageSizesOptions, 'log' | 'runCommand'> {
    log?: ICoreReadPdfPageSizesOptions['log'];
    runCommand?: typeof runNativeToolCommand;
}

export async function readPdfPageSizes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    return readCorePdfPageSizes(pdfPath, {
        ...options,
        log: options.log ?? (() => undefined),
        runCommand: options.runCommand ?? runNativeToolCommand,
    });
}
