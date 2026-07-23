import {
    describe,
    it,
    vi,
} from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { IDjvuInvokeMap } from '@electron/features/djvu/contract';
import type { IDjvuService } from '@electron/features/djvu/ports';
import {
    IMAGE_EXPORT_PLATFORM_FEATURE,
    type IImageExportInvokeMap,
} from '@contracts/imageExportPlatformFeature';
import type { IOcrInvokeMap } from '@electron/features/ocr/contract';
import type { IOcrService } from '@electron/features/ocr/ports';
import {
    PAGE_OPS_PLATFORM_FEATURE,
    type IPageOpsInvokeMap,
} from '@contracts/pageOpsPlatformFeature';
import {
    SEARCH_PLATFORM_FEATURE,
    type ISearchInvokeMap,
} from '@contracts/searchPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { registerPlatformFeatureHandlers } from '@electron/platform-ipc/validatedIpcRegistrar';
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
vi.mock('@electron/features/ocr/createOcrService', () => ({createOcrService: vi.fn()}));

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
        type TBindings = TFeatureMainBindings<typeof SEARCH_PLATFORM_FEATURE, IpcMainInvokeEvent>;
        const channels = SEARCH_PLATFORM_FEATURE.invokeChannels;
        await runCases<ISearchInvokeMap, TBindings>({
            channels,
            codecs: cast<Parameters<typeof runCases<ISearchInvokeMap, TBindings>>[0]['codecs']>(
                SEARCH_PLATFORM_FEATURE.ipcCodecs,
            ),
            register: (registrar, bindings) => registerPlatformFeatureHandlers(
                cast<Parameters<typeof registerPlatformFeatureHandlers>[0]>(registrar),
                SEARCH_PLATFORM_FEATURE,
                bindings,
            ),
            cases: [
                {
                    channel: channels.run,
                    validArgs: [{
                        pdfPath: '/tmp/a.pdf',
                        query: 'needle',
                    }],
                },
                {
                    channel: channels.warmIndex,
                    validArgs: [{pdfPath: '/tmp/a.pdf'}],
                },
                {
                    channel: channels.cancel,
                    validArgs: ['request-1'],
                },
                {
                    channel: channels.resetCache,
                    validArgs: [],
                },
                {
                    channel: channels.subscribeProgress,
                    validArgs: [],
                },
            ],
        });
    });

    it('exhaustively validates image-export registrar tuples', async () => {
        type TBindings = TFeatureMainBindings<typeof IMAGE_EXPORT_PLATFORM_FEATURE, IpcMainInvokeEvent>;
        const channels = IMAGE_EXPORT_PLATFORM_FEATURE.invokeChannels;
        await runCases<IImageExportInvokeMap, TBindings>({
            channels,
            codecs: cast<Parameters<typeof runCases<IImageExportInvokeMap, TBindings>>[0]['codecs']>(
                IMAGE_EXPORT_PLATFORM_FEATURE.ipcCodecs,
            ),
            register: (registrar, bindings) => registerPlatformFeatureHandlers(
                cast<Parameters<typeof registerPlatformFeatureHandlers>[0]>(registrar),
                IMAGE_EXPORT_PLATFORM_FEATURE,
                bindings,
            ),
            cases: [
                {
                    channel: channels.exportPdfToImages,
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
                    channel: channels.exportPdfToMultiPageTiff,
                    validArgs: [
                        '/tmp/a.djvu',
                        [1],
                        'request-2',
                        'djvu',
                    ],
                },
                {
                    channel: channels.subscribeProgress,
                    validArgs: [],
                },
            ],
        });
    });

    it('exhaustively validates page-ops registrar tuples', async () => {
        type TBindings = TFeatureMainBindings<typeof PAGE_OPS_PLATFORM_FEATURE, IpcMainInvokeEvent>;
        const channels = PAGE_OPS_PLATFORM_FEATURE.invokeChannels;
        await runCases<IPageOpsInvokeMap, TBindings>({
            channels,
            codecs: cast<Parameters<typeof runCases<IPageOpsInvokeMap, TBindings>>[0]['codecs']>(
                PAGE_OPS_PLATFORM_FEATURE.ipcCodecs,
            ),
            register: (registrar, bindings) => registerPlatformFeatureHandlers(
                cast<Parameters<typeof registerPlatformFeatureHandlers>[0]>(registrar),
                PAGE_OPS_PLATFORM_FEATURE,
                bindings,
            ),
            cases: [
                {
                    channel: channels.delete,
                    validArgs: [
                        '/tmp/a.pdf',
                        [1],
                        1,
                        undefined,
                    ],
                },
                {
                    channel: channels.extract,
                    validArgs: [
                        '/tmp/a.pdf',
                        [1],
                    ],
                },
                {
                    channel: channels.reorder,
                    validArgs: [
                        '/tmp/a.pdf',
                        [1],
                        undefined,
                    ],
                },
                {
                    channel: channels.insert,
                    validArgs: [
                        '/tmp/a.pdf',
                        1,
                        1,
                        undefined,
                    ],
                },
                {
                    channel: channels.insertFile,
                    validArgs: [
                        '/tmp/a.pdf',
                        1,
                        1,
                        ['/tmp/source.pdf'],
                        undefined,
                        undefined,
                    ],
                },
                {
                    channel: channels.rotate,
                    validArgs: [
                        '/tmp/a.pdf',
                        [1],
                        1,
                        90,
                        undefined,
                    ],
                },
                {
                    channel: channels.crop,
                    validArgs: [
                        '/tmp/a.pdf',
                        [1],
                        1,
                        {
                            top: 0,
                            right: 0,
                            bottom: 0,
                            left: 0,
                        },
                        undefined,
                    ],
                },
                {
                    channel: channels.removeCrop,
                    validArgs: [
                        '/tmp/a.pdf',
                        [1],
                        1,
                        undefined,
                    ],
                },
                {
                    channel: channels.getPageGeometry,
                    validArgs: [
                        '/tmp/a.pdf',
                        1,
                    ],
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
