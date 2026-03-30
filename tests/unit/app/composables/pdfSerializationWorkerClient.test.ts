import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPdfSerializationSavePayload } from '@app/composables/pdf/pdfSerializationOperations';

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
            const event = { data: {
                id: request.id,
                ok: true,
                data: request.payload.data,
            } } as MessageEvent;
            this.messageHandlers.forEach((handler) => handler(event));
        });
    }

    public dispatchEvent(_event: Event): boolean {
        return false;
    }

    public terminate() {}
}

describe('pdfSerializationWorkerClient', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
        FakeWorker.lastInstance = null;
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
    });

    it('posts full-span buffers with a transferable array buffer', async () => {
        const { serializePdfEditsOffThread } = await import('@app/composables/pdf/pdfSerializationWorkerClient');

        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        const payload: IPdfSerializationSavePayload = {
            markupSubtypeOverrides: [],
            markupSubtypeHints: [],
            shapes: [],
            deletedShapeAnnotationIds: [],
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
    });
});
