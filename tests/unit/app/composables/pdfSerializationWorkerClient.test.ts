import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPdfSerializationSavePayload } from '@app/modules/pdf-viewer/engine/pdf-serialization-operations/pdfSerializationSavePayload';

const yieldToBrowserMock = vi.hoisted(() => vi.fn(async () => {}));
const serializePdfEditsMock = vi.hoisted(() => vi.fn(async (data: Uint8Array) => data));
const workerCloneTimeoutMs = 8_000;

vi.mock('@app/utils/yieldToBrowser', () => ({ yieldToBrowser: yieldToBrowserMock }));
vi.mock('@app/modules/pdf-viewer/engine/pdf-serialization-operations/serializePdfEdits', () => ({ serializePdfEdits: serializePdfEditsMock }));

class FakeWorker {
    public static lastInstance: FakeWorker | null = null;

    public onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

    public onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

    public readonly postMessageCalls: Array<{
        message: unknown;
        transfer: Transferable[];
    }> = [];

    private readonly messageHandlers = new Set<(event: MessageEvent) => void>();

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
            return;
        }
        this.messageHandlers.add(handler as (event: MessageEvent) => void);
    }

    public removeEventListener(
        type: string,
        handler: EventListenerOrEventListenerObject | null,
    ) {
        if (type !== 'message' || typeof handler !== 'function') {
            return;
        }
        this.messageHandlers.delete(handler as (event: MessageEvent) => void);
    }

    public emitMessage(data: unknown) {
        const event = { data } as MessageEvent;
        this.messageHandlers.forEach((handler) => handler(event));
    }

    public postMessage(message: unknown, transfer: Transferable[]) {
        this.postMessageCalls.push({
            message,
            transfer,
        });

        queueMicrotask(() => {
            const request = message as {
                id: number;
                payload: { data: Uint8Array };
            };
            this.emitMessage({
                id: request.id,
                ok: true,
                data: request.payload.data,
            });
        });
    }

    public dispatchEvent(_event: Event) {
        return false;
    }

    public terminate() {}
}

describe('pdfSerializationWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        vi.useRealTimers();
        FakeWorker.lastInstance = null;
        yieldToBrowserMock.mockReset();
        yieldToBrowserMock.mockResolvedValue(undefined);
        serializePdfEditsMock.mockReset();
        serializePdfEditsMock.mockImplementation(async (data: Uint8Array) => data);
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
            pendingEmbeddedAnnotationDeletes: [],
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

    it('terminates the idle worker after the TTL elapses', async () => {
        vi.useFakeTimers();
        const terminateSpy = vi.spyOn(FakeWorker.prototype, 'terminate');
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
            pendingEmbeddedAnnotationDeletes: [],
            pageLabelsDirty: false,
            pageLabelRanges: [],
            totalPages: 0,
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: '',
            placedImage: null,
        };

        await serializePdfEditsOffThread(data, payload);
        await vi.runAllTicks();
        expect(terminateSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(15_000);
        expect(terminateSpy).toHaveBeenCalledTimes(1);
    });

    it('times out and falls back to direct execution when the worker never replies', async () => {
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
                pendingEmbeddedAnnotationDeletes: [],
                pageLabelsDirty: false,
                pageLabelRanges: [],
                totalPages: 0,
                bookmarksDirty: false,
                bookmarkItems: [],
                untitledBookmarkLabel: '',
                placedImage: null,
            };

            const pending = serializePdfEditsOffThread(data, payload);

            // Advance past the 30s hard ceiling — without the timeout fix
            // this promise would hang forever.
            await vi.advanceTimersByTimeAsync(30_000);
            await vi.runAllTimersAsync();

            // The catch-handler falls back to direct execution; with an
            // empty payload (no save work) it returns the original bytes.
            const result = await pending;
            expect(result).toEqual(data);
            // The wedged worker is torn down so subsequent saves get a
            // fresh instance.
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
                pendingEmbeddedAnnotationDeletes: [],
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
            pendingEmbeddedAnnotationDeletes: [],
            pageLabelsDirty: false,
            pageLabelRanges: [],
            totalPages: 0,
            bookmarksDirty: false,
            bookmarkItems: [],
            untitledBookmarkLabel: '',
            placedImage: null,
        };

        await serializePdfEditsOffThread(new Uint8Array([1]), payload);

        expect(yieldToBrowserMock).toHaveBeenCalledTimes(2);
    });
});
