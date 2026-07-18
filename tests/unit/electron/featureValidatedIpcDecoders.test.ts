import {
    describe,
    it,
    vi,
} from 'vitest';
import type { IDjvuInvokeMap } from '@electron/features/djvu/contract';
import type { IDjvuService } from '@electron/features/djvu/ports';
import type { IImageExportInvokeMap } from '@electron/features/image-export/contract';
import type { IImageExportService } from '@electron/features/image-export/ports';
import type { IOcrInvokeMap } from '@electron/features/ocr/contract';
import type { IOcrService } from '@electron/features/ocr/ports';
import type { ISearchInvokeMap } from '@electron/features/search/contract';
import type { ISearchService } from '@electron/features/search/searchService';
import { cast } from '@tests/helpers/cast';
import {
    assertValidatedRegistrarCases,
    createValidatedRegistrarHarness,
    type IValidatedRegistrarCase,
} from '@tests/unit/electron/helpers/validatedIpcRegistrarHarness';

const mocks = vi.hoisted(() => ({isTrustedIpcInvokeSender: vi.fn(() => true)}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: vi.fn(),
    },
    BrowserWindow: {fromWebContents: vi.fn(() => null)},
    ipcMain: {handle: vi.fn()},
}));
vi.mock('@electron/platform-ipc/trustedIpcSender', () => mocks);
vi.mock('@electron/features/djvu/createDjvuService', () => ({createDjvuService: vi.fn()}));
vi.mock('@electron/features/djvu/main/djvuArtifactManifest', () => ({pruneStaleDjvuArtifactJobs: vi.fn(async () => undefined)}));
vi.mock('@electron/features/image-export/createImageExportService', () => ({createImageExportService: vi.fn()}));
vi.mock('@electron/features/ocr/createOcrService', () => ({createOcrService: vi.fn()}));
vi.mock('@electron/features/search/createSearchService', () => ({createSearchService: vi.fn()}));

function createServiceDouble<T>() {
    return cast<T>(new Proxy({}, {get(target, property) {
        const record = target as Record<PropertyKey, unknown>;
        record[property] ??= vi.fn(async () => undefined);
        return record[property];
    }}));
}

async function runCases<TMap extends Record<keyof TMap, {
    args: unknown[];
    result: unknown
}>, TService>(options: {
    cases: IValidatedRegistrarCase[];
    channels: Record<string, string>;
    codecs: Parameters<typeof createValidatedRegistrarHarness<TMap, TService>>[0]['codecs'];
    register: Parameters<typeof createValidatedRegistrarHarness<TMap, TService>>[0]['register'];
}) {
    const handlers = createValidatedRegistrarHarness<TMap, TService>({
        channels: options.channels,
        codecs: options.codecs,
        register: options.register,
        service: createServiceDouble<TService>(),
    });
    await assertValidatedRegistrarCases({
        cases: options.cases,
        channels: options.channels,
        handlers,
        setTrusted: trusted => mocks.isTrustedIpcInvokeSender.mockReturnValue(trusted),
    });
}

describe('feature validated IPC decoders', () => {
    it('exhaustively validates Search registrar tuples', async () => {
        const { SEARCH_CHANNELS } = await import('@electron/features/search/contract');
        const { SEARCH_IPC_CODECS } = await import('@electron/features/search/searchIpcCodecs');
        const { registerSearchIpcAdapter } = await import('@electron/features/search/registerSearchIpcAdapter');
        await runCases<ISearchInvokeMap, ISearchService>({
            channels: SEARCH_CHANNELS,
            codecs: SEARCH_IPC_CODECS,
            register: registerSearchIpcAdapter,
            cases: [
                {
                    channel: SEARCH_CHANNELS.search,
                    validArgs: [{
                        pdfPath: '/tmp/a.pdf',
                        query: 'needle',
                    }],
                },
                {
                    channel: SEARCH_CHANNELS.warmIndex,
                    validArgs: [{pdfPath: '/tmp/a.pdf'}],
                },
                {
                    channel: SEARCH_CHANNELS.cancel,
                    validArgs: ['request-1'],
                },
                {
                    channel: SEARCH_CHANNELS.resetCache,
                    validArgs: [],
                },
                {
                    channel: SEARCH_CHANNELS.subscribeProgress,
                    validArgs: [],
                },
            ],
        });
    });

    it('exhaustively validates image-export registrar tuples', async () => {
        const { IMAGE_EXPORT_CHANNELS } = await import('@electron/features/image-export/contract');
        const { IMAGE_EXPORT_IPC_CODECS } = await import('@electron/features/image-export/imageExportIpcCodecs');
        const { registerImageExportIpcAdapter } = await import('@electron/features/image-export/registerImageExportIpcAdapter');
        await runCases<IImageExportInvokeMap, IImageExportService>({
            channels: IMAGE_EXPORT_CHANNELS,
            codecs: IMAGE_EXPORT_IPC_CODECS,
            register: registerImageExportIpcAdapter,
            cases: [
                {
                    channel: IMAGE_EXPORT_CHANNELS.exportImages,
                    validArgs: [
                        '/tmp/a.pdf',
                        [
                            1,
                            2,
                        ],
                        'request-1',
                        'pdf',
                    ],
                },
                {
                    channel: IMAGE_EXPORT_CHANNELS.exportMultiPageTiff,
                    validArgs: [
                        '/tmp/a.djvu',
                        [1],
                        'request-2',
                        'djvu',
                    ],
                },
                {
                    channel: IMAGE_EXPORT_CHANNELS.subscribeProgress,
                    validArgs: [],
                },
            ],
        });
    });

    it('exhaustively validates DjVu registrar tuples', async () => {
        const { DJVU_CHANNELS } = await import('@electron/features/djvu/contract');
        const { DJVU_IPC_CODECS } = await import('@electron/features/djvu/djvuIpcCodecs');
        const { registerDjvuIpcAdapter } = await import('@electron/features/djvu/registerDjvuIpcAdapter');
        const convertOptions = {
            preserveBookmarks: true,
            pdfStrategy: 'auto',
        };
        await runCases<IDjvuInvokeMap, IDjvuService>({
            channels: DJVU_CHANNELS,
            codecs: DJVU_IPC_CODECS,
            register: registerDjvuIpcAdapter,
            cases: [
                {
                    channel: DJVU_CHANNELS.startOpenForViewing,
                    validArgs: [
                        '/tmp/a.djvu',
                        'request-1',
                    ],
                },
                {
                    channel: DJVU_CHANNELS.awaitOpenJob,
                    validArgs: ['job-1'],
                },
                {
                    channel: DJVU_CHANNELS.openForViewing,
                    validArgs: ['/tmp/a.djvu'],
                },
                {
                    channel: DJVU_CHANNELS.releaseViewingPath,
                    validArgs: ['/tmp/a.djvu'],
                },
                {
                    channel: DJVU_CHANNELS.convertToPdf,
                    validArgs: [
                        '/tmp/a.djvu',
                        '/tmp/a.pdf',
                        convertOptions,
                    ],
                },
                {
                    channel: DJVU_CHANNELS.startConvertToPdf,
                    validArgs: [
                        '/tmp/a.djvu',
                        '/tmp/a.pdf',
                        convertOptions,
                    ],
                },
                {
                    channel: DJVU_CHANNELS.awaitConvertJob,
                    validArgs: ['job-1'],
                },
                {
                    channel: DJVU_CHANNELS.printDjvuPath,
                    validArgs: [
                        '/tmp/a.djvu',
                        {
                            viewMode: 'single',
                            orientation: 'auto',
                        },
                    ],
                },
                {
                    channel: DJVU_CHANNELS.cancel,
                    validArgs: ['job-1'],
                },
                {
                    channel: DJVU_CHANNELS.getJobState,
                    validArgs: ['job-1'],
                },
                {
                    channel: DJVU_CHANNELS.subscribeJob,
                    validArgs: ['job-1'],
                },
                {
                    channel: DJVU_CHANNELS.cancelPagePreview,
                    validArgs: ['request-1'],
                },
                {
                    channel: DJVU_CHANNELS.searchText,
                    validArgs: [
                        '/tmp/a.djvu',
                        'needle',
                        {
                            requestId: 'request-1',
                            pageCount: 12,
                        },
                    ],
                },
                {
                    channel: DJVU_CHANNELS.cancelTextSearch,
                    validArgs: ['request-1'],
                },
                {
                    channel: DJVU_CHANNELS.getInfo,
                    validArgs: ['/tmp/a.djvu'],
                },
                {
                    channel: DJVU_CHANNELS.getPageSourceInfo,
                    validArgs: [
                        '/tmp/a.djvu',
                        1,
                    ],
                },
                {
                    channel: DJVU_CHANNELS.getPageSizes,
                    validArgs: ['/tmp/a.djvu'],
                },
                {
                    channel: DJVU_CHANNELS.renderPagePreview,
                    validArgs: [
                        '/tmp/a.djvu',
                        1,
                        {targetWidthPx: 800},
                    ],
                },
                {
                    channel: DJVU_CHANNELS.estimateSizes,
                    validArgs: ['/tmp/a.djvu'],
                },
                {
                    channel: DJVU_CHANNELS.cleanupTemp,
                    validArgs: ['/tmp/a.pdf'],
                },
                {
                    channel: DJVU_CHANNELS.subscribeProgress,
                    validArgs: [],
                },
            ],
        });
    });

    it('exhaustively validates OCR registrar tuples', async () => {
        const { OCR_CHANNELS } = await import('@electron/features/ocr/contract');
        const { OCR_IPC_CODECS } = await import('@electron/features/ocr/ocrIpcCodecs');
        const { registerOcrIpcAdapter } = await import('@electron/features/ocr/registerOcrIpcAdapter');
        const request = {
            pageNumber: 1,
            imageData: new Uint8Array([
                1,
                2,
            ]),
            languages: ['eng'],
        };
        await runCases<IOcrInvokeMap, IOcrService>({
            channels: OCR_CHANNELS,
            codecs: OCR_IPC_CODECS,
            register: registerOcrIpcAdapter,
            cases: [
                {
                    channel: OCR_CHANNELS.recognize,
                    validArgs: [request],
                },
                {
                    channel: OCR_CHANNELS.recognizeBatch,
                    validArgs: [
                        [request],
                        'request-1',
                    ],
                },
                {
                    channel: OCR_CHANNELS.createSearchablePdf,
                    validArgs: [
                        '/tmp/a.pdf',
                        [{
                            pageNumber: 1,
                            languages: ['eng'],
                        }],
                        'request-1',
                        {renderDpi: 300},
                    ],
                },
                {
                    channel: OCR_CHANNELS.cancel,
                    validArgs: ['request-1'],
                },
                {
                    channel: OCR_CHANNELS.getJobState,
                    validArgs: ['request-1'],
                },
                {
                    channel: OCR_CHANNELS.subscribeJob,
                    validArgs: ['request-1'],
                },
                {
                    channel: OCR_CHANNELS.reconnectJob,
                    validArgs: ['request-1'],
                },
                {
                    channel: OCR_CHANNELS.acknowledgeResultFile,
                    validArgs: [
                        'request-1',
                        '/tmp/a.pdf',
                    ],
                },
                {
                    channel: OCR_CHANNELS.getLanguages,
                    validArgs: [],
                },
                {
                    channel: OCR_CHANNELS.resolveDocumentTextCatalog,
                    validArgs: [
                        '/tmp/a.pdf',
                        'drt1:test',
                        1,
                    ],
                },
                {
                    channel: OCR_CHANNELS.resolveDocumentOcrAvailability,
                    validArgs: [
                        '/tmp/a.pdf',
                        'drt1:test',
                    ],
                },
                {
                    channel: OCR_CHANNELS.resolveDocumentOcrPage,
                    validArgs: [
                        '/tmp/a.pdf',
                        'drt1:test',
                        1,
                    ],
                },
                {
                    channel: OCR_CHANNELS.validateTools,
                    validArgs: [],
                },
                {
                    channel: OCR_CHANNELS.preprocessingValidate,
                    validArgs: [],
                },
                {
                    channel: OCR_CHANNELS.preprocessingPreprocessPage,
                    validArgs: [
                        new Uint8Array([1]),
                        true,
                    ],
                },
                {
                    channel: OCR_CHANNELS.subscribeProgress,
                    validArgs: [],
                },
            ],
        });
    });
});
