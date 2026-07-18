import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAgentService } from '@electron/features/agent/ports';
import {
    AGENT_CHANNELS,
    AGENT_EVENT_CHANNELS,
    type IAgentInvokeMap,
} from '@electron/features/agent/contract';
import { AGENT_IPC_CODECS } from '@electron/features/agent/agentIpcCodecs';
import { createAgentPreloadClient } from '@electron/features/agent/createAgentPreloadClient';
import { registerAgentIpcAdapter } from '@electron/features/agent/registerAgentIpcAdapter';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import type { IDocumentsService } from '@electron/features/documents/documentsService';
import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    OCR_CHANNELS,
    type IOcrInvokeMap,
} from '@electron/features/ocr/contract';
import { createOcrPreloadClient } from '@electron/features/ocr/createOcrPreloadClient';
import { OCR_IPC_CODECS } from '@electron/features/ocr/ocrIpcCodecs';
import type { IOcrService } from '@electron/features/ocr/ports';
import { registerOcrIpcAdapter } from '@electron/features/ocr/registerOcrIpcAdapter';
import {
    PAGE_OPS_CHANNELS,
    type IPageOpsInvokeMap,
} from '@electron/features/page-ops/contract';
import { PAGE_OPS_IPC_CODECS } from '@electron/features/page-ops/pageOpsIpcCodecs';
import type { IPageOpsService } from '@electron/features/page-ops/ports';
import { registerPageOpsIpcAdapter } from '@electron/features/page-ops/registerPageOpsIpcAdapter';
import { createDocumentsPreloadPageOpsClient } from '@electron/features/documents/createDocumentsPreloadPageOpsClient';
import {
    SEARCH_CHANNELS,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import { createSearchPreloadClient } from '@electron/features/search/createSearchPreloadClient';
import { registerSearchIpcAdapter } from '@electron/features/search/registerSearchIpcAdapter';
import { SEARCH_IPC_CODECS } from '@electron/features/search/searchIpcCodecs';
import type { ISearchService } from '@electron/features/search/searchService';
import { cast } from '@tests/helpers/cast';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {
    createPdfPersistenceAckFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    isPdfPersistencePreloadToMainPayload,
} from '@contracts/documentPersistenceFrames';
import { createInProcessIpcRoundTripHarness } from '@tests/unit/electron/helpers/createInProcessIpcRoundTripHarness';

const mocks = vi.hoisted(() => ({
    appOn: vi.fn(),
    fromWebContents: vi.fn(() => null),
    isTrustedIpcInvokeSender: vi.fn(() => true),
}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        on: mocks.appOn,
    },
    BrowserWindow: {fromWebContents: mocks.fromWebContents},
    ipcMain: {
        handle: vi.fn(),
        on: vi.fn(),
    },
}));
vi.mock('@electron/platform-ipc/trustedIpcSender', () => ({
    isTrustedIpcInvokeSender: mocks.isTrustedIpcInvokeSender,
    isTrustedWebContentsSender: vi.fn(() => true),
}));
vi.mock('@electron/features/documents/createDocumentsService', () => ({createDocumentsService: vi.fn()}));
vi.mock('@electron/features/documents/public', () => ({attachSerializedPdfPersistencePort: vi.fn()}));
vi.mock('@electron/features/page-ops/createPageOpsService', () => ({createPageOpsService: vi.fn()}));
vi.mock('@electron/features/agent/createAgentService', () => ({createAgentService: vi.fn()}));
vi.mock('@electron/features/ocr/createOcrService', () => ({createOcrService: vi.fn()}));
vi.mock('@electron/features/search/createSearchService', () => ({createSearchService: vi.fn()}));
vi.mock('@electron/features/search/main/searchWorkerService', () => ({getSearchWorkerServiceConfig: () => ({
    idleTtlMs: 1,
    maxActive: 1,
    requestTimeoutMs: 1,
})}));

describe('in-process preload to validated IPC round trips', () => {
    beforeEach(() => {
        mocks.isTrustedIpcInvokeSender.mockReturnValue(true);
    });

    it('round-trips document binary arguments through the file preload client and adapter', async () => {
        const createWorkingCopyFromData = vi.fn(async () => '/tmp/working-copy.pdf');
        const beginSavePdfData = vi.fn(async () => ({sessionId: 'persistence-session-1'}));
        const receivedChunks: Uint8Array[] = [];
        const service = cast<IDocumentsService>({
            beginSavePdfData,
            createWorkingCopyFromData,
        });
        const harness = createInProcessIpcRoundTripHarness<IDocumentsInvokeMap, IDocumentsService, ReturnType<typeof createDocumentsPreloadFileClient>>({
            channels: DOCUMENTS_CHANNELS,
            codecs: DOCUMENTS_IPC_CODECS,
            createClient: createDocumentsPreloadFileClient,
            postMessage: (channel, sessionId, transfer) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.fileSavePdfDataPort);
                expect(sessionId).toBe('persistence-session-1');
                const port = transfer?.[0];
                if (!port) {
                    throw new Error('Missing transferred PDF persistence port');
                }
                port.addEventListener('message', (event) => {
                    const frame = event.data;
                    if (!isPdfPersistencePreloadToMainPayload(frame)) {
                        return;
                    }
                    if (frame.type === 'chunk') {
                        const bytes = frame.bytes instanceof Uint8Array
                            ? frame.bytes
                            : new Uint8Array(frame.bytes ?? new ArrayBuffer(0));
                        receivedChunks.push(Uint8Array.from(bytes));
                        port.postMessage(createPdfPersistenceAckFrame(frame.seq!, bytes.byteLength));
                    } else if (frame.type === 'complete') {
                        port.postMessage(createPdfPersistenceResultFrame('/tmp/working.pdf', {
                            errors: [],
                            isValid: true,
                            tool: 'browser',
                            warnings: [],
                        }));
                    }
                });
                port.start();
                port.postMessage(createPdfPersistenceReadyFrame());
            },
            register: (registrar, documentsService) => registerDocumentsIpcAdapter(
                registrar,
                documentsService,
                {eventRegistrar: {on: vi.fn()}},
            ),
            service,
        });
        const data = Uint8Array.from([
            1,
            3,
            5,
            7,
        ]);

        await expect(harness.client.createWorkingCopyFromData('round-trip.pdf', data, '/tmp/source.pdf'))
            .resolves.toBe('/tmp/working-copy.pdf');
        expect(createWorkingCopyFromData).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            'round-trip.pdf',
            data,
            '/tmp/source.pdf',
        );
        expect(harness.invokeCalls).toEqual([{
            args: [
                'round-trip.pdf',
                data,
                '/tmp/source.pdf',
            ],
            channel: DOCUMENTS_CHANNELS.createWorkingCopyFromData,
        }]);
        await expect(harness.client.savePdfDataChunks('/tmp/working.pdf', 5, [
            Uint8Array.from([
                1,
                2,
            ]),
            Uint8Array.from([
                3,
                4,
                5,
            ]),
        ], {expectedDocumentRevisionToken: requireDocumentRevisionToken('round-trip-revision')})).resolves.toMatchObject({
            isValid: true,
            tool: 'browser',
        });
        expect(receivedChunks).toEqual([
            Uint8Array.from([
                1,
                2,
            ]),
            Uint8Array.from([
                3,
                4,
                5,
            ]),
        ]);
    });

    it('round-trips page mutation tuples and rejects a malformed main-process result', async () => {
        const rotate = vi.fn()
            .mockResolvedValueOnce({
                pageCount: 4,
                success: true,
            })
            .mockResolvedValueOnce({success: 'yes'});
        const service = cast<IPageOpsService>({rotate});
        const harness = createInProcessIpcRoundTripHarness<IPageOpsInvokeMap, IPageOpsService, ReturnType<typeof createDocumentsPreloadPageOpsClient>>({
            channels: PAGE_OPS_CHANNELS,
            codecs: PAGE_OPS_IPC_CODECS,
            createClient: createDocumentsPreloadPageOpsClient,
            register: registerPageOpsIpcAdapter,
            service,
        });

        await expect(harness.client.rotate('/tmp/working-copy.pdf', [
            1,
            3,
        ], 4, 90))
            .resolves.toEqual({
                pageCount: 4,
                success: true,
            });
        expect(rotate).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            '/tmp/working-copy.pdf',
            [
                1,
                3,
            ],
            4,
            90,
            undefined,
        );
        await expect(harness.client.rotate('/tmp/working-copy.pdf', [2], 4, 180))
            .rejects.toThrow('page operation result must include success');
    });

    it('round-trips an agent command response and renderer acknowledgement', async () => {
        const submitCommandResponse = vi.fn(async () => ({accepted: true}));
        const service = cast<IAgentService>({submitCommandResponse});
        const harness = createInProcessIpcRoundTripHarness<IAgentInvokeMap, IAgentService, ReturnType<typeof createAgentPreloadClient>>({
            channels: AGENT_CHANNELS,
            codecs: AGENT_IPC_CODECS,
            createClient: createAgentPreloadClient,
            register: registerAgentIpcAdapter,
            service,
        });
        const response = {
            ok: true,
            requestId: 'command-1',
            result: {pageCount: 4},
        };

        await expect(harness.client.submitCommandResponse(response)).resolves.toEqual({accepted: true});
        expect(submitCommandResponse).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            response,
        );
        const callback = vi.fn();
        harness.client.onCommandCancelRequest(callback);

        harness.emit(AGENT_EVENT_CHANNELS.commandCancelRequest, {
            requestId: 'command-1',
            windowId: 9,
        });
        harness.emit(AGENT_EVENT_CHANNELS.commandCancelRequest, {requestId: ''});

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            requestId: 'command-1',
            windowId: 9,
        });
    });

    it('round-trips a search request and structured match response', async () => {
        const searchResult = {
            results: [{
                endOffset: 4,
                excerpt: {
                    after: ' result',
                    before: '',
                    match: 'test',
                    prefix: false,
                    suffix: false,
                },
                matchIndex: 0,
                pageMatchIndex: 0,
                pageNumber: 1,
                startOffset: 0,
            }],
            truncated: false,
        };
        const search = vi.fn(async () => searchResult);
        const service = cast<ISearchService>({search});
        const harness = createInProcessIpcRoundTripHarness<ISearchInvokeMap, ISearchService, ReturnType<typeof createSearchPreloadClient>>({
            channels: SEARCH_CHANNELS,
            codecs: SEARCH_IPC_CODECS,
            createClient: createSearchPreloadClient,
            register: registerSearchIpcAdapter,
            service,
        });

        await expect(harness.client.run('/tmp/working-copy.pdf', 'test', {
            pageCount: 4,
            requestId: 'search-1',
        })).resolves.toEqual(searchResult);
        expect(search).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            expect.objectContaining({
                pageCount: 4,
                pdfPath: '/tmp/working-copy.pdf',
                query: 'test',
                requestId: 'search-1',
            }),
        );
    });

    it('round-trips OCR cancellation and page-scoped catalog reads', async () => {
        const documentRevision = requireDocumentRevisionToken('drt1:ocr-page-round-trip');
        const cancel = vi.fn(async () => ({
            canceled: false,
            reason: 'not-found' as const,
        }));
        const resolveDocumentOcrAvailability = vi.fn(async () => ({
            documentRevision,
            pageCount: 406,
            pageNumbers: [406],
        }));
        const resolveDocumentOcrPage = vi.fn(async () => ({
            documentRevision,
            pageCount: 406,
            page: {
                pageNumber: 406,
                text: 'requested page',
                source: 'evb-ocr' as const,
                words: [{
                    text: 'requested',
                    x: 1,
                    y: 1,
                    width: 10,
                    height: 10,
                }],
                contentDigest: 'page-digest',
            },
        }));
        const service = cast<IOcrService>({
            cancel,
            resolveDocumentOcrAvailability,
            resolveDocumentOcrPage,
        });
        const harness = createInProcessIpcRoundTripHarness<IOcrInvokeMap, IOcrService, ReturnType<typeof createOcrPreloadClient>>({
            channels: OCR_CHANNELS,
            codecs: OCR_IPC_CODECS,
            createClient: createOcrPreloadClient,
            register: registerOcrIpcAdapter,
            service,
        });

        await expect(harness.client.cancel('ocr-request-1')).resolves.toEqual({
            canceled: false,
            reason: 'not-found',
        });
        expect(cancel).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            'ocr-request-1',
        );

        await expect(harness.client.resolveDocumentOcrAvailability!(
            '/tmp/working-copy.pdf',
            documentRevision,
        )).resolves.toMatchObject({pageNumbers: [406]});
        await expect(harness.client.resolveDocumentOcrPage!(
            '/tmp/working-copy.pdf',
            documentRevision,
            406,
        )).resolves.toMatchObject({page: {pageNumber: 406}});
        expect(resolveDocumentOcrAvailability).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            '/tmp/working-copy.pdf',
            documentRevision,
        );
        expect(resolveDocumentOcrPage).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            '/tmp/working-copy.pdf',
            documentRevision,
            406,
        );
    });
});
