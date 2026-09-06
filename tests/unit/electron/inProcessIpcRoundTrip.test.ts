import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {requireDocumentRef} from '@contracts/documentRef';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import {
    DOCUMENT_PLATFORM_FEATURES,
    type IDocumentMenuInvokeMap,
    type IDocumentPickerInvokeMap,
    type IDocumentRecentFilesInvokeMap,
    type IDocumentWindowInvokeMap,
} from '@contracts/documentsPlatformFeature';
import {
    createPdfPersistenceAckFrame,
    createPdfPersistenceReadyFrame,
    createPdfPersistenceResultFrame,
    isPdfPersistencePreloadToMainPayload,
    PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
    PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
    PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
    PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
} from '@contracts/documentPersistenceFrames';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';
import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import type {IBeginSerializedPdfPersistenceResult} from '@electron/features/documents/serializedPdfPersistenceContract';
import { createInProcessIpcRoundTripHarness } from '@tests/unit/electron/helpers/createInProcessIpcRoundTripHarness';
import { createDocumentsServiceFixture } from '@tests/unit/electron/helpers/createDocumentsServiceFixture';

const mocks = vi.hoisted(() => ({
    appOn: vi.fn(),
    fromWebContents: vi.fn(() => null),
    isTrustedIpcInvokeSender: vi.fn(() => true),
}));
type TDocumentsCombinedInvokeMap =
    & IDocumentsInvokeMap
    & IDocumentPickerInvokeMap
    & IDocumentRecentFilesInvokeMap
    & IDocumentWindowInvokeMap
    & IDocumentMenuInvokeMap;
const documentsCombinedChannels = {
    ...DOCUMENTS_CHANNELS,
    ...Object.assign({}, ...DOCUMENT_PLATFORM_FEATURES.map(feature => feature.invokeChannels)),
};
const documentsCombinedCodecs = {
    ...DOCUMENTS_IPC_CODECS,
    ...Object.assign({}, ...DOCUMENT_PLATFORM_FEATURES.map(feature => feature.ipcCodecs)),
};

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

describe('in-process preload to validated IPC round trips', () => {
    it('preserves paths and binary streams through the file preload client and adapter', async () => {
        const sourcePaths = [
            requireDocumentRef('/documents/duplicate-source-a/duplicate-recent-source.pdf'),
            requireDocumentRef('/documents/duplicate-source-b/duplicate-recent-source.pdf'),
        ];
        const receivedChunks: Uint8Array[] = [];
        const openDocumentDirect = vi.fn(async (_context: unknown, originalPath: string) => ({
            kind: 'pdf' as const,
            originalPath: requireDocumentRef(originalPath),
            workingPath: requireDocumentRef(`/managed/duplicate-source-${originalPath.includes('-a/') ? 'a' : 'b'}.pdf`),
        }));
        const persistenceBeginResult = {
            protocolVersion: 1,
            maxChunkBytes: PDF_PERSISTENCE_DEFAULT_CHUNK_BYTES,
            maxInFlightChunks: PDF_PERSISTENCE_DEFAULT_MAX_IN_FLIGHT_CHUNKS,
            maxTotalBytes: Number.MAX_SAFE_INTEGER,
            ackTimeoutMs: PDF_PERSISTENCE_DEFAULT_ACK_TIMEOUT_MS,
            resultTimeoutMs: PDF_PERSISTENCE_DEFAULT_RESULT_TIMEOUT_MS,
            sessionId: 'persistence-session-1',
        } satisfies IBeginSerializedPdfPersistenceResult;
        const service = createDocumentsServiceFixture({
            beginSavePdfData: vi.fn(async () => persistenceBeginResult),
            createWorkingCopyFromData: vi.fn(async () => requireDocumentRef('/tmp/working-copy.pdf')),
            openDocumentDirect,
            onWorkingCopyBackingStatusChanged: vi.fn(() => () => {}),
        });
        const harness = createInProcessIpcRoundTripHarness<
            TDocumentsCombinedInvokeMap,
            ReturnType<typeof createDocumentsServiceFixture>,
            ReturnType<typeof createDocumentsPreloadFileClient>
        >({
            channels: documentsCombinedChannels,
            codecs: documentsCombinedCodecs,
            createClient: createDocumentsPreloadFileClient,
            postMessage: (channel, sessionId, transfer) => {
                expect([
                    channel,
                    sessionId,
                ]).toEqual([
                    DOCUMENTS_CHANNELS.fileSavePdfDataPort,
                    'persistence-session-1',
                ]);
                const port = transfer?.[0];
                if (!port) {
                    throw new Error('Missing transferred PDF persistence port');
                }
                port.addEventListener('message', ({data: frame}) => {
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
                        port.postMessage(createPdfPersistenceResultFrame(requireDocumentRef('/tmp/working.pdf'), {
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

        await expect(harness.client.createWorkingCopyFromData('round-trip.pdf', data, requireDocumentRef('/tmp/source.pdf')))
            .resolves.toBe('/tmp/working-copy.pdf');
        expect(service.createWorkingCopyFromData).toHaveBeenCalledWith(
            expect.objectContaining({senderId: 7}),
            'round-trip.pdf',
            data,
            '/tmp/source.pdf',
        );
        await expect(harness.client.savePdfDataChunks(requireDocumentRef('/tmp/working.pdf'), 5, [
            Uint8Array.from([
                1,
                2,
            ]),
            Uint8Array.from([
                3,
                4,
                5,
            ]),
        ], {expectedDocumentRevisionToken: requireDocumentRevisionToken('round-trip-revision')}))
            .resolves.toMatchObject({
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

        const opened = await Promise.all(sourcePaths.map(path => harness.client.openDocumentDirect(path)));
        expect(opened.map(result => result?.workingPath)).toEqual([
            '/managed/duplicate-source-a.pdf',
            '/managed/duplicate-source-b.pdf',
        ]);
        expect(openDocumentDirect.mock.calls.map(call => call.slice(1))).toEqual(sourcePaths.map(path => [path]));
        expect(harness.invokeCalls.slice(-2)).toEqual(sourcePaths.map(path => ({
            args: [path],
            channel: DOCUMENTS_CHANNELS.openDocumentDirect,
        })));
    });
});
