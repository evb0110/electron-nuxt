import type { TIpcCodecMap } from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import {
    IMAGE_EXPORT_CHANNELS,
    type IImageExportInvokeMap,
} from '@electron/features/image-export/contract';
import {
    decodeOptionalStringArg,
    decodePositiveIntegerArrayArg,
    decodeStringArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    decodeNoArgs,
    decodeUndefinedResult,
    requireIpcArgumentCount,
} from '@electron/platform-ipc/ipcCodecValidation';

function decodeOptionalPageNumbers(args: readonly unknown[], index: number) {
    return args[index] === undefined
        ? undefined
        : decodePositiveIntegerArrayArg(args, index, 'pageNumbers');
}

function decodeOutputPaths(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) {
        throw new Error('outputPaths must be an array of strings');
    }
    const outputPaths: string[] = [];
    for (const path of value) {
        if (typeof path !== 'string') {
            throw new Error('outputPaths must be an array of strings');
        }
        outputPaths.push(path);
    }
    return outputPaths;
}

function decodeImagesResult(value: unknown) {
    if (
        !isRecord(value)
        || typeof value.success !== 'boolean'
        || (value.canceled !== undefined && typeof value.canceled !== 'boolean')
    ) {
        throw new Error('invalid image export result');
    }
    const outputPaths = decodeOutputPaths(value.outputPaths);
    return {
        success: value.success,
        ...(value.canceled === undefined ? {} : {canceled: value.canceled}),
        ...(outputPaths === undefined ? {} : {outputPaths}),
    };
}

function decodeMultiPageTiffResult(value: unknown) {
    if (!isRecord(value) || (value.outputPath !== undefined && typeof value.outputPath !== 'string')) {
        throw new Error('invalid multi-page TIFF export result');
    }
    return {
        ...decodeImagesResult(value),
        ...(value.outputPath === undefined ? {} : {outputPath: value.outputPath}),
    };
}

function decodeExportArgs(args: readonly unknown[]): IImageExportInvokeMap[typeof IMAGE_EXPORT_CHANNELS.exportImages]['args'] {
    requireIpcArgumentCount(args, {
        min: 1,
        max: 4,
    });
    const workingCopyPath = decodeStringArg(args, 0, 'workingCopyPath');
    const pageNumbers = decodeOptionalPageNumbers(args, 1);
    const requestId = decodeOptionalStringArg(args, 2, 'requestId');
    const sourceKind = args[3];
    if (sourceKind !== undefined && sourceKind !== 'pdf' && sourceKind !== 'djvu') {
        throw new Error('sourceKind must be pdf or djvu');
    }
    return [
        workingCopyPath,
        pageNumbers,
        requestId,
        sourceKind,
    ];
}

export const IMAGE_EXPORT_IPC_CODECS = {
    [IMAGE_EXPORT_CHANNELS.exportImages]: {
        decodeArgs: decodeExportArgs,
        decodeResult: decodeImagesResult,
    },
    [IMAGE_EXPORT_CHANNELS.exportMultiPageTiff]: {
        decodeArgs: decodeExportArgs,
        decodeResult: decodeMultiPageTiffResult,
    },
    [IMAGE_EXPORT_CHANNELS.subscribeProgress]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeUndefinedResult,
    },
} satisfies TIpcCodecMap<IImageExportInvokeMap>;
