import type { IpcRenderer } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';

class FakeMessagePort {
    readonly close = vi.fn();
    readonly start = vi.fn();
    readonly listeners = new Set<(event: MessageEvent) => void>();
    readonly postedMessages: unknown[] = [];
    shouldThrowOnChunk = false;
    onPostMessage?: (message: {type?: unknown}) => void;

    addEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        this.listeners.add(listener);
    }

    removeEventListener(_type: 'message', listener: (event: MessageEvent) => void) {
        this.listeners.delete(listener);
    }

    postMessage(message: {type?: unknown}) {
        if (this.shouldThrowOnChunk && message.type === 'chunk') {
            throw new Error('chunk post failed');
        }
        this.postedMessages.push(message);
        this.onPostMessage?.(message);
    }

    emit(data: unknown) {
        for (const listener of this.listeners) {
            listener({data} as MessageEvent);
        }
    }
}

interface INativeMutationInvokePayload {placedImages: Array<{bytes: unknown}>}

interface IWorkingCopyExpectationInvokePayload {
    byteLength: number;
    sha256: string;
}

describe('createDocumentsPreloadFileClient', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('closes the PDF persistence port when posting a streamed chunk fails', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        port1.shouldThrowOnChunk = true;
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.savePdfDataAsBegin) {
                    return {
                        sessionId: 'session-1',
                        path: '/tmp/saved.pdf',
                    };
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn((channel: string) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.fileSavePdfDataPort);
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfDataAs('/tmp/working.pdf', new Uint8Array([
            1,
            2,
            3,
        ]))).rejects.toThrow(
            'chunk post failed',
        );

        expect(port1.close).toHaveBeenCalledTimes(1);
    });

    it('streams PDF persistence chunks with tight backing buffers', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                    return {sessionId: 'session-1'};
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn((channel: string) => {
                expect(channel).toBe(DOCUMENTS_CHANNELS.fileSavePdfDataPort);
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const chunkBytes = 8 * 1024 * 1024;
        const sourceBytes = new Uint8Array(chunkBytes + 3);
        sourceBytes[0] = 1;
        sourceBytes[chunkBytes] = 2;
        sourceBytes[sourceBytes.byteLength - 1] = 3;
        port1.onPostMessage = (message) => {
            if (isChunkMessage(message)) {
                queueMicrotask(() => {
                    port1.emit({
                        type: 'ack',
                        seq: message.seq,
                    });
                });
                return;
            }
            if (message.type === 'complete') {
                queueMicrotask(() => {
                    port1.emit({
                        type: 'result',
                        path: '/tmp/saved.pdf',
                        validation: {
                            isValid: true,
                            tool: 'qpdf',
                            errors: [],
                            warnings: [],
                        },
                    });
                });
            }
        };
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfData('/tmp/working.pdf', sourceBytes)).resolves.toMatchObject({isValid: true});

        const chunks = port1.postedMessages.filter(isChunkMessage);
        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.bytes.buffer).not.toBe(sourceBytes.buffer);
        expect(chunks[0]?.bytes.byteOffset).toBe(0);
        expect(chunks[0]?.bytes.byteLength).toBe(chunkBytes);
        expect(chunks[0]?.bytes[0]).toBe(1);
        expect(chunks[1]?.bytes.buffer).not.toBe(sourceBytes.buffer);
        expect(chunks[1]?.bytes.byteOffset).toBe(0);
        expect(chunks[1]?.bytes.byteLength).toBe(3);
        expect(chunks[1]?.bytes[0]).toBe(2);
        expect(chunks[1]?.bytes[2]).toBe(3);
    });

    it('keeps a bounded pair of PDF persistence chunks in flight', async () => {
        const port1 = new FakeMessagePort();
        const port2 = new FakeMessagePort();
        vi.stubGlobal('MessageChannel', class {
            readonly port1 = port1;
            readonly port2 = port2;
        });
        const ipcRenderer = {
            invoke: vi.fn(async (channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.fileSavePdfDataBegin) {
                    return {sessionId: 'session-1'};
                }
                throw new Error(`Unexpected invoke: ${channel}`);
            }),
            postMessage: vi.fn(() => {
                queueMicrotask(() => {
                    port1.emit({type: 'ready'});
                });
            }),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const sourceBytes = new Uint8Array((8 * 1024 * 1024) + 1);

        const savePromise = client.savePdfData('/tmp/working.pdf', sourceBytes);
        await waitForPostedChunkCount(port1, 2);

        expect(port1.postedMessages.some(message => isPortMessage(message, 'complete'))).toBe(false);

        port1.emit({
            type: 'ack',
            seq: 0,
        });
        await Promise.resolve();
        expect(port1.postedMessages.some(message => isPortMessage(message, 'complete'))).toBe(false);

        port1.emit({
            type: 'ack',
            seq: 1,
        });
        await waitForPortMessage(port1, 'complete');
        port1.emit({
            type: 'result',
            path: '/tmp/saved.pdf',
            validation: {
                isValid: true,
                tool: 'qpdf',
                errors: [],
                warnings: [],
            },
        });

        await expect(savePromise).resolves.toMatchObject({isValid: true});
    });

    it('invokes the native note text update channel with validated updates', async () => {
        const ipcRenderer = {
            invoke: vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>(async () => ({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'qpdf' as const,
                    errors: [],
                    warnings: [],
                },
            })),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfNoteTextUpdates!('/tmp/working.pdf', [{
            objectNumber: 42,
            generationNumber: 0,
            text: 'Updated note',
        }], 'D:20260609133855+03\'00\'')).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates,
            '/tmp/working.pdf',
            [{
                objectNumber: 42,
                generationNumber: 0,
                text: 'Updated note',
            }],
            'D:20260609133855+03\'00\'',
        );
    });

    it('rejects invalid native note text update requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        expect(() => client.savePdfNoteTextUpdates!('/tmp/working.pdf', [], 'D:20260609133855+03\'00\''))
            .toThrow('savePdfNoteTextUpdates.updates must be a non-empty array');

        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('validates native FreeText note change requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'qpdf' as const,
                    errors: [],
                    warnings: [],
                },
            })),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        const freeTextNotes = [{
            pageIndex: 0,
            stableKey: 'uid:0:pdfjs_internal_editor_0',
            text: 'Editor note',
            markerRect: {
                left: 0.1,
                top: 0.2,
                width: 0.0016,
                height: 0.0016,
            },
            author: 'Tester',
            color: 'rgba(255, 204, 0, 0.8)',
            createdAt: 1781009077000,
        }];

        await expect(client.savePdfNoteChanges!(
            '/tmp/working.pdf',
            {
                updates: [],
                freeTextNotes,
                deletes: [
                    {
                        pageIndex: 0,
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: 0,
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: 1781009077000,
                    },
                ],
            },
            'D:20260609133855+03\'00\'',
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
            '/tmp/working.pdf',
            {
                freeTextNotes: [expect.objectContaining({
                    stableKey: 'uid:0:pdfjs_internal_editor_0',
                    text: 'Editor note',
                })],
                deletes: [
                    {
                        pageIndex: 0,
                        objectNumber: 3856,
                        generationNumber: 0,
                    },
                    {
                        pageIndex: 0,
                        stableKey: 'uid:0:pdfjs_internal_editor_0',
                        createdAt: 1781009077000,
                    },
                ],
            },
            'D:20260609133855+03\'00\'',
        );
    });

    it('validates native PDF metadata mutation requests before IPC', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => ({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'native' as const,
                    errors: [],
                    warnings: [],
                },
            })),
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);

        await expect(client.savePdfNativeMutations!(
            '/tmp/working.pdf',
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: [{
                        id: 'shape-1',
                        type: 'rectangle',
                        pageIndex: 0,
                        x: 0.1,
                        y: 0.2,
                        width: 0.3,
                        height: 0.2,
                        color: '#336699',
                        fillColor: '#abcdef',
                        opacity: 0.5,
                        strokeWidth: 3,
                        stableKey: 'evb-shape:shape-1',
                        createdAt: 1781009077000,
                        modifiedAt: 1781009087000,
                    }],
                    deletedAnnotationIds: ['44R'],
                    deletedStableKeys: ['evb-shape:deleted'],
                },
                markup: {
                    overrides: [[
                        '44R',
                        'Squiggly',
                    ]],
                    hints: [{
                        subtype: 'Squiggly',
                        pageIndex: 0,
                        markerRect: {
                            left: 0.1,
                            top: 0.2,
                            width: 0.3,
                            height: 0.2,
                        },
                        annotationId: '44R',
                        color: '#22c55e',
                        id: 'markup-1',
                        pageMarkupIndex: 0,
                        source: 'editor-live',
                    }],
                },
            },
            'D:20260609133855+03\'00\'',
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileSavePdfNativeMutations,
            '/tmp/working.pdf',
            {
                pageLabels: {
                    totalPages: 3,
                    ranges: [{
                        startPage: 1,
                        style: 'r',
                        prefix: 'intro-',
                        startNumber: 2,
                    }],
                },
                bookmarks: {
                    totalPages: 3,
                    untitledLabel: 'Untitled',
                    items: [{
                        title: 'Chapter 1',
                        pageIndex: 0,
                        namedDest: null,
                        bold: true,
                        italic: false,
                        color: '#336699',
                        items: [],
                    }],
                },
                shapes: {
                    totalPages: 3,
                    rewriteShapeState: true,
                    shapes: [expect.objectContaining({
                        id: 'shape-1',
                        type: 'rectangle',
                        stableKey: 'evb-shape:shape-1',
                    })],
                    deletedAnnotationIds: ['44R'],
                    deletedStableKeys: ['evb-shape:deleted'],
                },
                markup: {
                    overrides: [[
                        '44R',
                        'Squiggly',
                    ]],
                    hints: [expect.objectContaining({
                        subtype: 'Squiggly',
                        annotationId: '44R',
                        color: '#22c55e',
                    })],
                },
            },
            'D:20260609133855+03\'00\'',
        );
    });

    it('validates native working-copy placed image mutations before IPC', async () => {
        const invoke = vi.fn<(
            channel: string,
            path: string,
            mutations: INativeMutationInvokePayload,
            modifiedAt: string,
            expectedBase: IWorkingCopyExpectationInvokePayload,
        ) => Promise<unknown>>(async () => ({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native' as const,
                errors: [],
                warnings: [],
            },
        }));
        const ipcRenderer = {
            invoke,
            postMessage: vi.fn(),
        } satisfies Pick<IpcRenderer, 'invoke' | 'postMessage'>;
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const expectedBase = {
            byteLength: 3,
            sha256: 'a'.repeat(64),
        };
        const imageBytes = new Uint8Array([
            0xFF,
            0xD8,
            0xFF,
        ]);

        await expect(client.applyPdfNativeMutationsToWorkingCopy!(
            '/tmp/working.pdf',
            {placedImages: [{
                pageIndex: 0,
                x: 0.1,
                y: 0.2,
                width: 0.3,
                height: 0.2,
                rotationDegrees: 15,
                mimeType: 'image/jpeg',
                bytes: imageBytes,
            }]},
            'D:20260609133855+03\'00\'',
            expectedBase,
        )).resolves.toMatchObject({applied: true});

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy,
            '/tmp/working.pdf',
            {placedImages: [expect.objectContaining({
                pageIndex: 0,
                mimeType: 'image/jpeg',
                bytes: imageBytes,
            })]},
            'D:20260609133855+03\'00\'',
            expectedBase,
        );
        const firstCall = invoke.mock.calls[0];
        expect(firstCall).toBeDefined();
        if (!firstCall) {
            throw new Error('Expected native mutation IPC call');
        }
        const mutations = firstCall[2];
        expect(mutations.placedImages[0]?.bytes).toBeInstanceOf(Uint8Array);
    });
});

function isChunkMessage(message: unknown): message is {
    type: 'chunk';
    seq: number;
    bytes: Uint8Array;
} {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === 'chunk'
        && 'seq' in message
        && typeof message.seq === 'number'
        && 'bytes' in message
        && message.bytes instanceof Uint8Array,
    );
}

function isPortMessage(message: unknown, type: string) {
    return Boolean(
        message
        && typeof message === 'object'
        && 'type' in message
        && message.type === type,
    );
}

async function waitForPostedChunkCount(port: FakeMessagePort, expectedCount: number) {
    await waitForCondition(() => {
        expect(port.postedMessages.filter(isChunkMessage)).toHaveLength(expectedCount);
    });
}

async function waitForPortMessage(port: FakeMessagePort, type: string) {
    await waitForCondition(() => {
        expect(port.postedMessages.some(message => isPortMessage(message, type))).toBe(true);
    });
}

async function waitForCondition(assertion: () => void) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
            assertion();
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
    throw lastError;
}
