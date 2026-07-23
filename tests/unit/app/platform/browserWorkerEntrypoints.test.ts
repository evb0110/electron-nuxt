import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

vi.mock('pdfjs-dist', () => ({getDocument: vi.fn()}));

describe('browser worker entrypoints', {timeout: 20_000}, () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('registers every worker and safely rejects a malformed request frame', async () => {
        const messageHandlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
        const postMessage = vi.fn();
        vi.stubGlobal('self', {
            addEventListener: vi.fn((type: string, handler: (event: MessageEvent<unknown>) => Promise<void>) => {
                if (type === 'message') {
                    messageHandlers.push(handler);
                }
            }),
            postMessage,
        });

        await Promise.all([
            import('@app/modules/pdf-viewer/engine/pdfSerialization.worker'),
            import('@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations.worker'),
            import('@app/platform/browser-api/browserPageOps.worker'),
            import('@app/platform/browser-api/browserPdfCombine.worker'),
            import('@app/platform/browser-api/browserSearch.worker'),
        ]);

        expect(messageHandlers).toHaveLength(5);
        for (const handler of messageHandlers) {
            await handler({data: {id: 17}} as MessageEvent<unknown>);
        }
        expect(postMessage).toHaveBeenCalledTimes(5);
        expect(postMessage.mock.calls.every(call => call[0]?.ok === false)).toBe(true);
    });
});
