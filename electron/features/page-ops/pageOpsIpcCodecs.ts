import type {
    IPageOpsExtractResult,
    IPageOpsInsertResult,
    IPageOpsMetadataSnapshot,
    IPageOpsMutationOptions,
    IPageOpsResult,
    TPageOpsRotationAngle,
} from '@contracts/electronApiPageOps';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
} from '@contracts/documentRevision';
import type { IPageGeometry } from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/contract';
import {
    decodeOptionalObjectWithKeys,
    decodeOptionalStringArg,
    decodePositiveIntegerArrayArg,
    decodeSafeIntegerArg,
    decodeStringArg,
    decodeStringArrayArg,
} from '@electron/platform-ipc/ipcArgumentValidation';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import { requireIpcArgumentCount } from '@electron/platform-ipc/ipcCodecValidation';

function decodeExactArgs<T>(
    args: readonly unknown[],
    count: number,
    decode: () => T,
) {
    requireIpcArgumentCount(args, count);
    return decode();
}

function decodeBookmarkEntries(
    value: unknown,
    depth = 0,
    counter = {value: 0},
): IPdfBookmarkEntry[] {
    if (!Array.isArray(value) || depth > 64) {
        throw new Error('options.metadataSnapshot.bookmarks must be a bounded bookmark array');
    }
    return value.map((raw): IPdfBookmarkEntry => {
        counter.value += 1;
        if (counter.value > 5_000) {
            throw new Error('options.metadataSnapshot.bookmarks exceeds the item limit');
        }
        if (!isRecord(raw)) {
            throw new Error('options.metadataSnapshot.bookmarks contains an invalid bookmark');
        }
        const pageIndex = raw.pageIndex;
        if (pageIndex !== null && (!Number.isSafeInteger(pageIndex) || (pageIndex as number) < 0)) {
            throw new Error('bookmark.pageIndex must be a non-negative integer or null');
        }
        if (
            typeof raw.title !== 'string'
            || raw.title.length > 4_096
            || (raw.namedDest !== null && typeof raw.namedDest !== 'string')
            || typeof raw.bold !== 'boolean'
            || typeof raw.italic !== 'boolean'
            || (raw.color !== null && typeof raw.color !== 'string')
        ) {
            throw new Error('options.metadataSnapshot.bookmarks contains invalid fields');
        }
        const pageYRatio = raw.pageYRatio;
        if (pageYRatio !== undefined && pageYRatio !== null && !isFiniteNumber(pageYRatio)) {
            throw new Error('bookmark.pageYRatio must be finite or null');
        }
        return {
            title: raw.title,
            pageIndex: pageIndex as number | null,
            ...(pageYRatio === undefined ? {} : {pageYRatio}),
            namedDest: raw.namedDest,
            bold: raw.bold,
            italic: raw.italic,
            color: raw.color,
            items: decodeBookmarkEntries(raw.items, depth + 1, counter),
        };
    });
}

function decodePageMetadataSnapshot(value: unknown): IPageOpsMetadataSnapshot {
    if (!isRecord(value)) {
        throw new Error('options.metadataSnapshot must be an object');
    }
    const pageLabels = value.pageLabels;
    if (
        pageLabels !== null
        && (
            !Array.isArray(pageLabels)
            || pageLabels.length > 1_000_000
            || !pageLabels.every(label => typeof label === 'string' && label.length <= 4_096)
        )
    ) {
        throw new Error('options.metadataSnapshot.pageLabels must be a string array or null');
    }
    if (typeof value.untitledBookmarkLabel !== 'string') {
        throw new Error('options.metadataSnapshot.untitledBookmarkLabel must be a string');
    }
    return {
        pageLabels: pageLabels,
        bookmarks: decodeBookmarkEntries(value.bookmarks),
        untitledBookmarkLabel: value.untitledBookmarkLabel,
    };
}

function decodePageOpsMutationOptions(value: unknown): IPageOpsMutationOptions | undefined {
    const options = decodeOptionalObjectWithKeys(value, 'options', [
        'expectedDocumentRevisionToken',
        'metadataSnapshot',
    ]);
    if (options === undefined) {
        return undefined;
    }
    const tokenValue = options.expectedDocumentRevisionToken;
    if (tokenValue === undefined) {
        return options.metadataSnapshot === undefined
            ? {}
            : {metadataSnapshot: decodePageMetadataSnapshot(options.metadataSnapshot)};
    }
    if (tokenValue === null) {
        return {
            expectedDocumentRevisionToken: null,
            ...(options.metadataSnapshot === undefined
                ? {}
                : {metadataSnapshot: decodePageMetadataSnapshot(options.metadataSnapshot)}),
        };
    }
    const token = parseDocumentRevisionToken(tokenValue);
    if (token === null) {
        throw new Error('options.expectedDocumentRevisionToken must be a valid document revision token or null');
    }
    return {
        expectedDocumentRevisionToken: token,
        ...(options.metadataSnapshot === undefined
            ? {}
            : {metadataSnapshot: decodePageMetadataSnapshot(options.metadataSnapshot)}),
    };
}

function decodeRotationAngle(args: readonly unknown[], index: number): TPageOpsRotationAngle {
    const angle = decodeSafeIntegerArg(args, index, 'angle', 0);
    if (angle !== 90 && angle !== 180 && angle !== 270) {
        throw new Error('angle must be 90, 180, or 270');
    }
    return angle;
}

function decodeRevision(value: unknown): IDocumentRevisionInfo | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isDocumentRevisionInfo(value)) {
        throw new Error('documentRevision must be valid');
    }
    return {
        version: value.version,
        token: value.token,
        documentRef: value.documentRef,
        authority: value.authority,
        contentRevision: value.contentRevision,
        mintedAt: value.mintedAt,
    };
}

function decodeOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${fieldName} must be a boolean`);
    }
    return value;
}

function decodePageOpsResult(value: unknown): IPageOpsResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page operation result must include success');
    }
    const pageCount = value.pageCount === undefined
        ? undefined
        : decodeSafeIntegerArg([value.pageCount], 0, 'pageCount', 0);
    const documentRevision = decodeRevision(value.documentRevision);
    return {
        success: value.success,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

function decodeExtractResult(value: unknown): IPageOpsExtractResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page extraction result must include success');
    }
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    if (value.destPath !== undefined && typeof value.destPath !== 'string') {
        throw new Error('destPath must be a string');
    }
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(value.destPath === undefined ? {} : {destPath: value.destPath}),
    };
}

function decodeInsertResult(value: unknown): IPageOpsInsertResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page insertion result must include success');
    }
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    const documentRevision = decodeRevision(value.documentRevision);
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

function decodePdfBox(value: unknown) {
    if (
        !isRecord(value)
        || !isFiniteNumber(value.x)
        || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        throw new Error('page geometry box must contain finite coordinates');
    }
    return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
    };
}

function decodePageGeometry(value: unknown): IPageGeometry {
    if (!isRecord(value) || !isFiniteNumber(value.rotation)) {
        throw new Error('page geometry must contain a finite rotation');
    }
    return {
        mediaBox: decodePdfBox(value.mediaBox),
        cropBox: value.cropBox === null ? null : decodePdfBox(value.cropBox),
        rotation: value.rotation,
    };
}

export const PAGE_OPS_IPC_CODECS = {
    [PAGE_OPS_CHANNELS.delete]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 4, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'pages'),
            decodeSafeIntegerArg(args, 2, 'totalPages', 1),
            decodePageOpsMutationOptions(args[3]),
        ]),
        decodeResult: decodePageOpsResult,
    },
    [PAGE_OPS_CHANNELS.extract]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 2, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'pages'),
        ]),
        decodeResult: decodeExtractResult,
    },
    [PAGE_OPS_CHANNELS.reorder]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 3, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'newOrder'),
            decodePageOpsMutationOptions(args[2]),
        ]),
        decodeResult: decodePageOpsResult,
    },
    [PAGE_OPS_CHANNELS.insert]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 4, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodeSafeIntegerArg(args, 1, 'totalPages', 0),
            decodeSafeIntegerArg(args, 2, 'afterPage', 0),
            decodePageOpsMutationOptions(args[3]),
        ]),
        decodeResult: decodeInsertResult,
    },
    [PAGE_OPS_CHANNELS.insertFile]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 6, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodeSafeIntegerArg(args, 1, 'totalPages', 0),
            decodeSafeIntegerArg(args, 2, 'afterPage', 0),
            decodeStringArrayArg(args, 3, 'sourcePaths'),
            decodeOptionalStringArg(args, 4, 'requestId'),
            decodePageOpsMutationOptions(args[5]),
        ]),
        decodeResult: decodePageOpsResult,
    },
    [PAGE_OPS_CHANNELS.rotate]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 5, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'pages'),
            decodeSafeIntegerArg(args, 2, 'totalPages', 1),
            decodeRotationAngle(args, 3),
            decodePageOpsMutationOptions(args[4]),
        ]),
        decodeResult: decodePageOpsResult,
    },
    [PAGE_OPS_CHANNELS.crop]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 5, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'pages'),
            decodeSafeIntegerArg(args, 2, 'totalPages', 1),
            normalizeCropMargins(args[3]),
            decodePageOpsMutationOptions(args[4]),
        ]),
        decodeResult: decodePageOpsResult,
    },
    [PAGE_OPS_CHANNELS.removeCrop]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 4, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodePositiveIntegerArrayArg(args, 1, 'pages'),
            decodeSafeIntegerArg(args, 2, 'totalPages', 1),
            decodePageOpsMutationOptions(args[3]),
        ]),
        decodeResult: decodePageOpsResult,
    },
    [PAGE_OPS_CHANNELS.getPageGeometry]: {
        decodeArgs: (args: readonly unknown[]) => decodeExactArgs(args, 2, () => [
            decodeStringArg(args, 0, 'workingCopyPath'),
            decodeSafeIntegerArg(args, 1, 'pageNumber', 1),
        ]),
        decodeResult: decodePageGeometry,
    },
} satisfies TIpcCodecMap<IPageOpsInvokeMap>;
