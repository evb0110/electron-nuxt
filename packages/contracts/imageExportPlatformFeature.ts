import type {
    IImageExportProgress,
    TDocumentImageExportSourceKind,
} from '@contracts/electronApiDocuments';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

const MAX_COLLECTION_ITEMS = 100_000;
const IMAGE_EXPORT_REQUEST_ID_MAX_LENGTH = 128;

type TImageExportArgs = [
    workingCopyPath: string,
    pageNumbers: number[] | undefined,
    requestId: string | undefined,
    sourceKind: TDocumentImageExportSourceKind | undefined,
];

function decodeOptionalPageNumbers(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('pageNumbers must be a non-empty array');
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`pageNumbers exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    if (value.some(page => typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1)) {
        throw new Error('pageNumbers must contain positive safe integers');
    }
    if (new Set(value).size !== value.length) {
        throw new Error('pageNumbers must contain unique pages');
    }
    return value as number[];
}

function decodeOptionalRequestId(value: unknown) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error('requestId must be a string');
    }
    const requestId = value.trim();
    if (!requestId) {
        return undefined;
    }
    if (requestId.length > IMAGE_EXPORT_REQUEST_ID_MAX_LENGTH) {
        throw new Error(`requestId exceeds maximum length (${IMAGE_EXPORT_REQUEST_ID_MAX_LENGTH})`);
    }
    return requestId;
}

function decodeExportArgs(value: unknown): TImageExportArgs {
    if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
        throw new Error(`expected 1-4 arguments, received ${Array.isArray(value) ? value.length : 0}`);
    }
    const items: unknown[] = value;
    const workingCopyPath = items[0];
    if (typeof workingCopyPath !== 'string' || workingCopyPath.trim().length === 0) {
        throw new Error('workingCopyPath must be a non-empty string');
    }
    const requestId = decodeOptionalRequestId(items[2]);
    const sourceKind = items[3];
    if (sourceKind !== undefined && sourceKind !== 'pdf' && sourceKind !== 'djvu') {
        throw new Error('sourceKind must be pdf or djvu');
    }
    return [
        workingCopyPath,
        decodeOptionalPageNumbers(items[1]),
        requestId,
        sourceKind,
    ];
}

function decodeOutputPaths(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.some(path => typeof path !== 'string')) {
        throw new Error('outputPaths must be an array of strings');
    }
    return value as string[];
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

function decodeImageExportProgress(value: unknown): IImageExportProgress | null {
    if (
        !isRecord(value)
        || typeof value.requestId !== 'string'
        || (value.format !== 'images' && value.format !== 'multipage-tiff')
        || (value.phase !== 'rendering' && value.phase !== 'combining')
        || !isFiniteNumber(value.processed)
        || !isFiniteNumber(value.total)
        || !isFiniteNumber(value.percent)
        || (
            value.status !== undefined
            && value.status !== 'running'
            && value.status !== 'success'
            && value.status !== 'canceled'
            && value.status !== 'failed'
        )
        || (value.error !== undefined && typeof value.error !== 'string')
    ) {
        return null;
    }
    return {
        requestId: value.requestId,
        format: value.format,
        phase: value.phase,
        processed: value.processed,
        total: value.total,
        percent: value.percent,
        ...(value.status === undefined ? {} : {status: value.status}),
        ...(value.error === undefined ? {} : {error: value.error}),
    };
}

const exportArgs = s.fromParser<TImageExportArgs>(
    decodeExportArgs,
    () => [
        '/tmp/fixture.pdf',
        [1],
        'image-export-fixture',
        'pdf',
    ],
);
const progress = s.declared<IImageExportProgress>()(
    s.fromNullableDecoder(decodeImageExportProgress, 'image export progress', () => ({
        requestId: 'image-export-fixture',
        format: 'images',
        phase: 'rendering',
        processed: 0,
        total: 1,
        percent: 0,
        status: 'running',
    })),
);
const replay = {
    owner: 'ipc-progress-pump',
    mode: 'latest-per-key',
    key: (payload: IImageExportProgress) => payload.requestId,
    terminal: (payload: IImageExportProgress) =>
        payload.status === 'success' || payload.status === 'canceled' || payload.status === 'failed',
    intervalMs: 50,
    terminalRetentionMs: 30_000,
} as const;

export const IMAGE_EXPORT_PLATFORM_FEATURE = definePlatformFeature({
    path: ['imageExport'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        exportPdfToImages: {
            kind: 'async',
            channel: 'pdfExport:images',
            ipc: {
                args: exportArgs,
                result: s.fromParser(decodeImagesResult, () => ({
                    success: true,
                    outputPaths: [],
                })),
                timeoutMs: 30 * 60 * 1_000,
            },
            client: {mapArgs: (
                workingCopyPath: string,
                pageNumbers?: number[],
                requestId?: string,
                sourceKind?: TDocumentImageExportSourceKind,
            ): TImageExportArgs => [
                workingCopyPath,
                pageNumbers,
                requestId,
                sourceKind,
            ]},
            main: {
                method: 'exportImages',
                context: 'sender',
            },
            browser: {method: 'exportPdfToImages'},
            lazy: 'forwarded',
        },
        exportPdfToMultiPageTiff: {
            kind: 'async',
            channel: 'pdfExport:multipage-tiff',
            ipc: {
                args: exportArgs,
                result: s.fromParser(decodeMultiPageTiffResult, () => ({
                    success: true,
                    outputPath: '/tmp/fixture.tiff',
                    outputPaths: ['/tmp/fixture.tiff'],
                })),
                timeoutMs: 30 * 60 * 1_000,
            },
            client: {mapArgs: (
                workingCopyPath: string,
                pageNumbers?: number[],
                requestId?: string,
                sourceKind?: TDocumentImageExportSourceKind,
            ): TImageExportArgs => [
                workingCopyPath,
                pageNumbers,
                requestId,
                sourceKind,
            ]},
            main: {
                method: 'exportMultiPageTiff',
                context: 'sender',
            },
            browser: {method: 'exportPdfToMultiPageTiff'},
            lazy: 'forwarded',
        },
    },
    events: {onProgress: {
        kind: 'event',
        channel: 'pdfExport:progress',
        payload: progress,
        subscription: {
            channel: 'pdfExport:progress:subscribe',
            request: 'once-per-preload-event-channel',
            main: {
                method: 'subscribeProgress',
                context: 'sender',
            },
            replay,
        },
        browser: {method: 'onProgress'},
        lazy: 'forwarded',
    }},
});

export type IImageExportCapability = TFeatureCapability<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
export type IImageExportInvokeMap = TFeatureInvokeMap<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
export type IImageExportEventMap = TFeatureEventMap<typeof IMAGE_EXPORT_PLATFORM_FEATURE>;
