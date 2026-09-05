import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';
import { requireDocumentRevisionToken } from '@contracts';
import {requireDocumentRef} from '@contracts/documentRef';
import { BROWSER_MAX_FULL_READ_BYTES } from '@app/platform/browser/browserDocumentConstants';

const failureReceipt = {
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'RENDERER_PDF_SERIALIZATION_WORKER_FAILED',
    occurredAt: 1,
    severity: 'error',
};
const failureReporter = {capture: vi.fn(() => failureReceipt)};

vi.mock('@app/utils/failureReporter', () => ({
    detectRendererDiagnosticsHost: () => 'hosted-browser',
    getRendererFailureReporter: () => failureReporter,
    initializeRendererFailureReporter: () => failureReporter,
}));

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const serializePdfEditsMock = vi.hoisted(() => vi.fn(async (data: Uint8Array) => data));
const readDocumentBytesMock = vi.hoisted(() => vi.fn());
const getDocumentRevisionMock = vi.hoisted(() => vi.fn());
const workerCloneTimeoutMs = 8_000;

vi.mock('@app/utils/yieldToBrowser', () => ({ yieldToBrowser: yieldToBrowserMock }));
vi.mock('@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits', () => ({ serializePdfEdits: serializePdfEditsMock }));
vi.mock('@app/utils/documentBytes', () => ({ readDocumentBytes: readDocumentBytesMock }));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => ({getDocumentRevision: getDocumentRevisionMock})}));

function createSavePayload(): IPdfSerializationSavePayload {
    return {
        markupSubtypeOverrides: [],
        markupSubtypeHints: [],
        rewriteShapeState: false,
        shapes: [],
        deletedShapeAnnotationIds: [],
        deletedShapeStableKeys: [],
        freeTextComments: [],
        annotationComments: [],
        pendingEmbeddedTextUpdates: [],
        pageLabelsDirty: false,
        pageLabelRanges: [],
        totalPages: 0,
        bookmarksDirty: false,
        bookmarkItems: [],
        untitledBookmarkLabel: '',
        placedImage: null,
    };
}

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;
    public static failWithError = false;

    public onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

    public onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

    public readonly postMessageCalls: Array<{
        message: unknown;
        transfer: Transferable[];
    }> = [];

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();
    private readonly errorHandlers = new Set<(event: ErrorEvent) => void>();

    public constructor(
        _scriptUrl: string | URL,
        _options?: WorkerOptions,
    ) {
        FakeWorker.lastInstance = this;
    }

    public addEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (type !== 'message' || typeof handler !== 'function') {
            if (type === 'error' && typeof handler === 'function') {
                this.errorHandlers.add(handler as (event: ErrorEvent) => void);
            }
            return;
        }
        this.messageHandlers.add(handler as (event: MessageEvent) => void);
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (type !== 'message' || typeof handler !== 'function') {
            if (type === 'error' && typeof handler === 'function') {
                this.errorHandlers.delete(handler as (event: ErrorEvent) => void);
            }
            return;
        }
        this.messageHandlers.delete(handler as (event: MessageEvent) => void);
    }

    public emitMessage(data: unknown) {
        const event = { data } as MessageEvent;
        this.messageHandlers.forEach((handler) => handler(event));
    }

    public dispatchError(error: Error) {
        const event = {
            error,
            message: error.message,
        } as ErrorEvent;
        this.errorHandlers.forEach((handler) => handler(event));
    }

    public postMessage(message: unknown, transfer: Transferable[]) {
        this.postMessageCalls.push({
            message,
            transfer,
        });

        if (FakeWorker.failWithError) {
            queueMicrotask(() => this.dispatchError(new Error('serialization worker crashed')));
            return;
        }

        queueMicrotask(() => {
            const request = message as {
                id: number;
                type: string;
                payload: { data: Uint8Array };
            };
            this.emitMessage({
                id: request.id,
                ok: true,
                data: request.type === 'bindCanonicalAnnotationIdentities'
                    ? {
                        data: request.payload.data,
                        identityBindings: [{
                            annotationId: 'canonical-1',
                            pdfRef: '12R',
                        }],
                    }
                    : request.payload.data,
            });
        });
    }

    public dispatchEvent(_event: Event) {
        return false;
    }

    public terminate() {}
}

describe('pdfSerializationWorkerClient', {timeout: 20_000}, () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        FakeWorker.lastInstance = null;
        FakeWorker.failWithError = false;
        failureReporter.capture.mockClear();
        yieldToBrowserMock.mockReset();
        yieldToBrowserMock.mockResolvedValue(undefined);
        serializePdfEditsMock.mockReset();
        serializePdfEditsMock.mockImplementation(async (data: Uint8Array) => data);
        readDocumentBytesMock.mockReset();
        getDocumentRevisionMock.mockReset();
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('posts a cloned buffer to the worker so the caller data stays attached', async () => {
        const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        const payload: IPdfSerializationSavePayload = {
            markupSubtypeOverrides: [],
            markupSubtypeHints: [],
            rewriteShapeState: false,
            shapes: [],
            deletedShapeAnnotationIds: [],
            deletedShapeStableKeys: [],
            freeTextComments: [],
            annotationComments: [],
            pendingEmbeddedTextUpdates: [],
            pageLabelsDirty: false,
            pageLabelRanges: [],
            totalPages: 0,
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: '',
            placedImage: null,
        };

        const result = await serializePdfEditsOffThread(data, payload);

        expect(result).toEqual(data);

        const worker = FakeWorker.lastInstance;
        expect(worker).not.toBeNull();
        expect(worker?.postMessageCalls).toHaveLength(1);
        const firstCall = worker?.postMessageCalls[0];
        expect(firstCall?.transfer).toHaveLength(1);

        const request = firstCall?.message as { payload: { data: Uint8Array } };
        expect(firstCall?.transfer[0]).toBe(request.payload.data.buffer);
        expect(request.payload.data.buffer).not.toBe(data.buffer);
        expect(Array.from(data)).toEqual([
            1,
            2,
            3,
        ]);
    }, workerCloneTimeoutMs);

    it('transfers a disposable full-span path read without copying it', async () => {
        const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');
        const data = new Uint8Array([
            7,
            8,
            9,
        ]);
        const revision = requireDocumentRevisionToken('drt1:test:disposable-transfer');
        const payload = createSavePayload();

        await serializePdfEditsOffThread({
            bytes: data,
            ownership: 'disposable',
            reloadPath: requireDocumentRef('browser://documents/disposable.pdf'),
            revision,
        }, payload);

        const call = FakeWorker.lastInstance?.postMessageCalls[0];
        const request = call?.message as { payload: { data: Uint8Array } };
        expect(request.payload.data.buffer).toBe(data.buffer);
        expect(call?.transfer).toEqual([data.buffer]);
    });

    it('reloads the exact revision before direct fallback after a disposable transfer detaches', async () => {
        const revision = requireDocumentRevisionToken('drt1:test:disposable-reload');
        const reloaded = new Uint8Array([
            4,
            5,
            6,
        ]);
        getDocumentRevisionMock.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/disposable.pdf',
            token: revision,
            contentRevision: 1,
            authority: 'electron-working-copy',
            mintedAt: 1,
        });
        readDocumentBytesMock.mockResolvedValue(reloaded);
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function detachingFailure(
            message: unknown,
            transfer: Transferable[],
        ) {
            this.postMessageCalls.push({
                message,
                transfer,
            });
            structuredClone(message, {transfer});
            throw new Error('worker transport failed');
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');
            const data = new Uint8Array([
                1,
                2,
                3,
            ]);
            const payload = createSavePayload();

            await expect(serializePdfEditsOffThread({
                bytes: data,
                ownership: 'disposable',
                reloadPath: requireDocumentRef('browser://documents/disposable.pdf'),
                revision,
            }, payload)).resolves.toBe(reloaded);

            expect(data.byteLength).toBe(0);
            expect(readDocumentBytesMock).toHaveBeenCalledWith('browser://documents/disposable.pdf');
            expect(getDocumentRevisionMock).toHaveBeenCalledTimes(2);
            expect(serializePdfEditsMock).toHaveBeenCalledWith(reloaded, payload);
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('rejects direct fallback when the disposable source revision has changed', async () => {
        const revision = requireDocumentRevisionToken('drt1:test:disposable-stale');
        getDocumentRevisionMock.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/disposable.pdf',
            token: requireDocumentRevisionToken('drt1:test:disposable-newer'),
            contentRevision: 2,
            authority: 'electron-working-copy',
            mintedAt: 2,
        });
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function detachingFailure(
            message: unknown,
            transfer: Transferable[],
        ) {
            structuredClone(message, {transfer});
            throw new Error('worker transport failed');
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

            await expect(serializePdfEditsOffThread({
                bytes: new Uint8Array([
                    1,
                    2,
                    3,
                ]),
                ownership: 'disposable',
                reloadPath: requireDocumentRef('browser://documents/disposable.pdf'),
                revision,
            }, createSavePayload())).rejects.toThrow('revision changed before reload');

            expect(readDocumentBytesMock).not.toHaveBeenCalled();
            expect(serializePdfEditsMock).not.toHaveBeenCalled();
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('fails closed before reloading a large native path after a disposable transfer detaches', async () => {
        const revision = requireDocumentRevisionToken('drt1:test:native-disposable-reload');
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function detachingFailure(
            message: unknown,
            transfer: Transferable[],
        ) {
            structuredClone(message, {transfer});
            throw new Error('worker transport failed');
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

            await expect(serializePdfEditsOffThread({
                bytes: new Uint8Array([
                    1,
                    2,
                    3,
                ]),
                ownership: 'disposable',
                reloadPath: requireDocumentRef('/tmp/large-native.pdf'),
                revision,
            }, createSavePayload())).rejects.toMatchObject({
                code: 'native-save-required',
                failure: {
                    code: 'native-save-required',
                    phase: 'pre-write',
                    reason: 'missing-native-capability',
                },
            });

            expect(readDocumentBytesMock).not.toHaveBeenCalled();
            expect(getDocumentRevisionMock).not.toHaveBeenCalled();
            expect(serializePdfEditsMock).not.toHaveBeenCalled();
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('binds canonical identities in the worker and replays serializable identity evidence', async () => {
        const {bindCanonicalAnnotationIdentitiesOffThread} = await import(
            '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/bindCanonicalAnnotationIdentitiesOffThread'
        );
        const data = new Uint8Array([
            4,
            5,
            6,
        ]);
        const onIdentityBound = vi.fn();

        const result = await bindCanonicalAnnotationIdentitiesOffThread(
            data,
            [],
            [],
            {onIdentityBound},
        );

        expect(result).toEqual({
            data,
            identityBindings: [{
                annotationId: 'canonical-1',
                pdfRef: '12R',
            }],
        });
        expect(onIdentityBound).toHaveBeenCalledWith({
            annotationId: 'canonical-1',
            pdfRef: '12R',
        });
        const worker = FakeWorker.lastInstance;
        const call = worker?.postMessageCalls[0];
        const request = call?.message as {
            type: string;
            payload: {
                data: Uint8Array;
                evidence: Record<string, unknown>;
            };
        };
        expect(request.type).toBe('bindCanonicalAnnotationIdentities');
        expect(request.payload.evidence).not.toHaveProperty('onIdentityBound');
        expect(call?.transfer).toEqual([request.payload.data.buffer]);
        expect(request.payload.data.buffer).not.toBe(data.buffer);
        expect(Array.from(data)).toEqual([
            4,
            5,
            6,
        ]);
    }, workerCloneTimeoutMs);

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        terminateSpy.mockClear();
        const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        const payload: IPdfSerializationSavePayload = {
            markupSubtypeOverrides: [],
            markupSubtypeHints: [],
            rewriteShapeState: false,
            shapes: [],
            deletedShapeAnnotationIds: [],
            deletedShapeStableKeys: [],
            freeTextComments: [],
            annotationComments: [],
            pendingEmbeddedTextUpdates: [],
            pageLabelsDirty: false,
            pageLabelRanges: [],
            totalPages: 0,
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: '',
            placedImage: null,
        };

        await serializePdfEditsOffThread(data, payload);
        vi.runAllTicks();
        expect(terminateSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(1);
        expect(failureReporter.capture).not.toHaveBeenCalled();
    });

    it('owns a worker failure once and preserves its receipt through fallback rejection', async () => {
        FakeWorker.failWithError = true;
        const fallbackError = new Error('serialization fallback failed');
        serializePdfEditsMock.mockRejectedValue(fallbackError);
        const {serializePdfEditsOffThread} = await import(
            '@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread'
        );

        const error = await serializePdfEditsOffThread(
            new Uint8Array([
                1,
                2,
                3,
            ]),
            createSavePayload(),
        ).then(
            () => { throw new Error('Expected a worker failure'); },
            value => {
                if (!(value instanceof Error)) {
                    throw new Error('Expected a worker failure');
                }
                return value as Error & {failure?: unknown};
            },
        );

        expect(failureReporter.capture).toHaveBeenCalledOnce();
        expect(failureReporter.capture).toHaveBeenCalledWith(
            expect.objectContaining({local: expect.objectContaining({source: 'pdf-serialization-worker-parent'})}),
            {runtime: 'browser-worker-parent'},
        );
        expect(error.failure).toBe(failureReceipt);
        expect({failure: error.failure}.failure).toBe(failureReceipt);
    });

    it('rejects and resets the worker when the worker never replies', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        // Override postMessage so the worker silently swallows the request
        // (simulates the regression where the worker hung indefinitely
        // and the renderer await never settled).
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function silentPostMessage(
            message: unknown,
            transfer,
        ) {
            this.postMessageCalls.push({
                message,
                transfer,
            });
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

            const data = new Uint8Array([
                1,
                2,
                3,
            ]);
            const payload: IPdfSerializationSavePayload = {
                markupSubtypeOverrides: [],
                markupSubtypeHints: [],
                rewriteShapeState: false,
                shapes: [],
                deletedShapeAnnotationIds: [],
                deletedShapeStableKeys: [],
                freeTextComments: [],
                annotationComments: [],
                pendingEmbeddedTextUpdates: [],
                pageLabelsDirty: false,
                pageLabelRanges: [],
                totalPages: 0,
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: '',
                placedImage: null,
            };

            const pending = serializePdfEditsOffThread(data, payload);
            const rejection = expect(pending).rejects.toThrow('PDF serialization worker did not reply');

            await vi.advanceTimersByTimeAsync(30_000);

            await rejection;
            expect(serializePdfEditsMock).not.toHaveBeenCalled();
            expect(yieldToBrowserMock).not.toHaveBeenCalled();
            expect(terminateSpy).toHaveBeenCalled();
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('allows a legitimate large serialization request more time to finish', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        terminateSpy.mockClear();
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function silentPostMessage(
            message: unknown,
            transfer,
        ) {
            this.postMessageCalls.push({
                message,
                transfer,
            });
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');
            const payload: IPdfSerializationSavePayload = {
                markupSubtypeOverrides: [],
                markupSubtypeHints: [],
                rewriteShapeState: false,
                shapes: [],
                deletedShapeAnnotationIds: [],
                deletedShapeStableKeys: [],
                freeTextComments: [],
                annotationComments: [],
                pendingEmbeddedTextUpdates: [],
                pageLabelsDirty: false,
                pageLabelRanges: [],
                totalPages: 0,
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: '',
                placedImage: null,
            };
            const data = new Uint8Array(8 * 1024 * 1024 + 1);
            const pending = serializePdfEditsOffThread(data, payload);
            const outcome = pending.then(
                () => null,
                (error: unknown) => error,
            );

            await vi.advanceTimersByTimeAsync(30_000);
            expect(terminateSpy).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(5_000);
            await expect(outcome).resolves.toMatchObject({message: expect.stringContaining('within 35000ms')});
            expect(terminateSpy).toHaveBeenCalled();
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('starts a queued serialization request only after the active worker times out', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function silentPostMessage(
            message: unknown,
            transfer,
        ) {
            this.postMessageCalls.push({
                message,
                transfer,
            });
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');
            const payload: IPdfSerializationSavePayload = {
                markupSubtypeOverrides: [],
                markupSubtypeHints: [],
                rewriteShapeState: false,
                shapes: [],
                deletedShapeAnnotationIds: [],
                deletedShapeStableKeys: [],
                freeTextComments: [],
                annotationComments: [],
                pendingEmbeddedTextUpdates: [],
                pageLabelsDirty: false,
                pageLabelRanges: [],
                totalPages: 0,
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: '',
                placedImage: null,
            };

            const firstData = new Uint8Array([1]);
            const secondData = new Uint8Array([2]);
            const first = serializePdfEditsOffThread(firstData, payload);
            await vi.advanceTimersByTimeAsync(1_000);
            const second = serializePdfEditsOffThread(secondData, payload);
            const firstRejection = expect(first).rejects.toThrow('PDF serialization worker did not reply');
            const secondRejection = expect(second).rejects.toThrow('PDF serialization worker did not reply');

            await vi.advanceTimersByTimeAsync(29_000);

            await firstRejection;
            await vi.advanceTimersByTimeAsync(30_000);
            await secondRejection;
            expect(serializePdfEditsMock).not.toHaveBeenCalled();
            expect(yieldToBrowserMock).not.toHaveBeenCalled();
            expect(terminateSpy).toHaveBeenCalled();
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('rejects structured worker operation errors without direct fallback', async () => {
        const originalPostMessage = FakeWorker.prototype.postMessage;
        FakeWorker.prototype.postMessage = function failingOperationPostMessage(
            this: FakeWorker,
            message: unknown,
            transfer: Transferable[],
        ) {
            this.postMessageCalls.push({
                message,
                transfer,
            });

            queueMicrotask(() => {
                const request = message as { id: number };
                this.emitMessage({
                    id: request.id,
                    ok: false,
                    error: 'deterministic serialization failure',
                });
            });
        };

        try {
            const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

            const payload: IPdfSerializationSavePayload = {
                markupSubtypeOverrides: [],
                markupSubtypeHints: [],
                rewriteShapeState: false,
                shapes: [],
                deletedShapeAnnotationIds: [],
                deletedShapeStableKeys: [],
                freeTextComments: [],
                annotationComments: [],
                pendingEmbeddedTextUpdates: [],
                pageLabelsDirty: false,
                pageLabelRanges: [],
                totalPages: 0,
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: '',
                placedImage: null,
            };

            await expect(serializePdfEditsOffThread(new Uint8Array([1]), payload))
                .rejects.toThrow('deterministic serialization failure');
            expect(serializePdfEditsMock).not.toHaveBeenCalled();
            expect(yieldToBrowserMock).not.toHaveBeenCalled();
        } finally {
            FakeWorker.prototype.postMessage = originalPostMessage;
        }
    });

    it('yields around direct fallback work when workers are unavailable', async () => {
        vi.unstubAllGlobals();
        vi.stubGlobal('window', {});

        const { serializePdfEditsOffThread } = await import('@app/modules/pdf-viewer/engine/pdf-serialization-worker-client/serializePdfEditsOffThread');

        const payload: IPdfSerializationSavePayload = {
            markupSubtypeOverrides: [],
            markupSubtypeHints: [],
            rewriteShapeState: false,
            shapes: [],
            deletedShapeAnnotationIds: [],
            deletedShapeStableKeys: [],
            freeTextComments: [],
            annotationComments: [],
            pendingEmbeddedTextUpdates: [],
            pageLabelsDirty: false,
            pageLabelRanges: [],
            totalPages: 0,
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: '',
            placedImage: null,
        };

        await serializePdfEditsOffThread(new Uint8Array([1]), payload);
        await expect(serializePdfEditsOffThread(
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES),
            payload,
        )).resolves.toBeInstanceOf(Uint8Array);
        await expect(serializePdfEditsOffThread(
            new Uint8Array(BROWSER_MAX_FULL_READ_BYTES + 1),
            payload,
        )).rejects.toThrow('PDF serialization input exceeds the 16 MiB worker limit');

        expect(yieldToBrowserMock).toHaveBeenCalledTimes(4);
    });
});
