import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

vi.mock('pdfjs-dist', () => ({getDocument: vi.fn()}));

const combineWasmMock = vi.hoisted(() => ({tryCombineImageInputsWithWasm: vi.fn()}));

vi.mock('@app/platform/browser-api/tryCombineImageInputsWithWasm', () => combineWasmMock);

describe('browser worker entrypoints', {timeout: 20_000}, () => {
    beforeEach(() => {
        vi.resetModules();
        combineWasmMock.tryCombineImageInputsWithWasm.mockReset();
    });

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

    it('rejects an oversized WASM PDF before returning a worker success frame', async () => {
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
        class OversizedPdfBytes extends Uint8Array {
            public override get byteLength() {
                return 16 * 1024 * 1024 + 1;
            }
        }
        combineWasmMock.tryCombineImageInputsWithWasm.mockResolvedValue({
            status: 'success',
            data: new OversizedPdfBytes([0x25]),
        });
        const validPngHeader = new Uint8Array(24);
        validPngHeader.set([
            0x89,
            0x50,
            0x4e,
            0x47,
            0x0d,
            0x0a,
            0x1a,
            0x0a,
            0x00,
            0x00,
            0x00,
            0x0d,
            0x49,
            0x48,
            0x44,
            0x52,
        ], 0);
        new DataView(validPngHeader.buffer).setUint32(16, 1);
        new DataView(validPngHeader.buffer).setUint32(20, 1);

        await import('@app/platform/browser-api/browserPdfCombine.worker');
        expect(messageHandlers).toHaveLength(1);
        await messageHandlers[0]!({data: {
            id: 1,
            type: 'combinePdfs',
            payload: {inputs: [{
                fileName: 'scan.png',
                data: validPngHeader,
            }]},
        }} as MessageEvent<unknown>);

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            id: 1,
            ok: false,
            error: expect.stringContaining('shared browser combine cap'),
            errorEnvelope: expect.objectContaining({
                code: 'too-large',
                message: expect.stringContaining('shared browser combine cap'),
            }),
        }));
    });
});
