import type { IpcRenderer } from 'electron';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/preloadFileClient';

class FakeMessagePort {
    readonly close = vi.fn();
    readonly start = vi.fn();
    readonly listeners = new Set<(event: MessageEvent) => void>();
    shouldThrowOnChunk = false;

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
    }

    emit(data: unknown) {
        for (const listener of this.listeners) {
            listener({data} as MessageEvent);
        }
    }
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
});
