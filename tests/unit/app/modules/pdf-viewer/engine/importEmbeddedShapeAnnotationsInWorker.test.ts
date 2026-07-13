import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import {
    importEmbeddedShapeAnnotationsFromPathInWorker,
    importEmbeddedShapeAnnotationsUsingWorker,
} from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient';

const documentMocks = vi.hoisted(() => ({
    readFileRange: vi.fn(),
    statFile: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations', () => ({ importEmbeddedShapeAnnotations: vi.fn() }));
vi.mock('@app/utils/platformDocuments', () => ({ getDocumentFilesCapability: () => documentMocks }));

describe('importEmbeddedShapeAnnotationsUsingWorker', () => {
    beforeEach(() => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue([]);
        documentMocks.readFileRange.mockReset();
        documentMocks.statFile.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('falls back to the direct importer outside a browser worker runtime', async () => {
        const data = new Uint8Array([1]);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(data)).resolves.toEqual([]);

        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledWith(data);
    });

    it('transfers an owned copy to a module worker without detaching session bytes', async () => {
        let postedData: Uint8Array | null = null;
        let postedTransfer: Transferable[] | undefined;
        const terminate = vi.fn();

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: {data: Uint8Array}, transfer?: Transferable[]) {
                postedData = message.data;
                postedTransfer = transfer;
                const event = { data: {
                    ok: true,
                    shapes: [],
                } } as MessageEvent;
                queueMicrotask(() => this.onmessage?.(event));
            }

            terminate() {
                terminate();
            }
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(data)).resolves.toEqual([]);

        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
        expect(postedData).not.toBe(data);
        expect(postedData).toEqual(data);
        expect(postedTransfer).toEqual([postedData!.buffer]);
        expect(data.byteLength).toBe(3);
        expect(terminate).toHaveBeenCalledOnce();
    });

    it('transfers a disposable path-read buffer without making another whole-file copy', async () => {
        let postedData: Uint8Array | null = null;
        let postedTransfer: Transferable[] | undefined;

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: {data: Uint8Array}, transfer?: Transferable[]) {
                postedData = message.data;
                postedTransfer = transfer;
                queueMicrotask(() => this.onmessage?.({data: {
                    ok: true,
                    shapes: [],
                }} as MessageEvent));
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
        const disposablePathRead = new Uint8Array([
            1,
            2,
            3,
        ]);

        await expect(importEmbeddedShapeAnnotationsUsingWorker(
            disposablePathRead,
            { transferOwnership: true },
        )).resolves.toEqual([]);

        expect(postedData).toBe(disposablePathRead);
        expect(postedTransfer).toEqual([disposablePathRead.buffer]);
    });

    it('copies a disposable subarray before transfer so unrelated backing bytes stay owned', async () => {
        let postedData: Uint8Array | null = null;

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: {data: Uint8Array}) {
                postedData = message.data;
                queueMicrotask(() => this.onmessage?.({data: {
                    ok: true,
                    shapes: [],
                }} as MessageEvent));
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);
        const backing = new Uint8Array([
            9,
            1,
            2,
            3,
            8,
        ]);
        const subarray = backing.subarray(1, 4);

        await importEmbeddedShapeAnnotationsUsingWorker(subarray, {transferOwnership: true});

        expect(postedData).not.toBe(subarray);
        expect(postedData).toEqual(new Uint8Array([
            1,
            2,
            3,
        ]));
        expect(postedData!.buffer).not.toBe(backing.buffer);
    });

    it('streams path-backed PDFs to the worker in bounded chunks', async () => {
        const posted: Array<{
            message: Record<string, unknown>;
            transfer?: Transferable[]
        }> = [];
        const documentSize = 5 * 1024 * 1024;
        documentMocks.statFile.mockResolvedValue({size: documentSize});
        documentMocks.readFileRange.mockImplementation(async (_path, _offset, length) => new Uint8Array(length));

        class FakeWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(message: Record<string, unknown>, transfer?: Transferable[]) {
                posted.push(transfer ? {
                    message,
                    transfer,
                } : {message});
                if (message.type === 'path-finish') {
                    queueMicrotask(() => this.onmessage?.({data: {
                        ok: true,
                        shapes: [],
                    }} as MessageEvent));
                }
            }

            terminate() {}
        }

        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', FakeWorker);

        await expect(importEmbeddedShapeAnnotationsFromPathInWorker('/tmp/large.pdf')).resolves.toEqual([]);

        expect(documentMocks.readFileRange).toHaveBeenNthCalledWith(1, '/tmp/large.pdf', 0, 4 * 1024 * 1024);
        expect(documentMocks.readFileRange).toHaveBeenNthCalledWith(2, '/tmp/large.pdf', 4 * 1024 * 1024, 1024 * 1024);
        expect(posted.map(entry => entry.message.type)).toEqual([
            'path-start',
            'path-chunk',
            'path-chunk',
            'path-finish',
        ]);
    });

    it('terminates superseded worker parsing immediately', async () => {
        const terminate = vi.fn();
        class PendingWorker {
            onmessage: ((event: MessageEvent) => void) | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;
            postMessage() {}
            terminate() { terminate(); }
        }
        vi.stubGlobal('window', {});
        vi.stubGlobal('Worker', PendingWorker);
        const controller = new AbortController();
        const importPromise = importEmbeddedShapeAnnotationsUsingWorker(
            new Uint8Array([1]),
            { signal: controller.signal },
        );

        controller.abort(new DOMException('Superseded source', 'AbortError'));

        await expect(importPromise).rejects.toMatchObject({name: 'AbortError'});
        expect(terminate).toHaveBeenCalledOnce();
    });
});
