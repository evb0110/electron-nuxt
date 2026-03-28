import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const pdfjsModule = vi.hoisted(() => ({
    GlobalWorkerOptions: { workerSrc: undefined as string | undefined },
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);

describe('browser api common', () => {
    beforeEach(() => {
        vi.resetModules();
        pdfjsModule.getDocument.mockReset();
        pdfjsModule.GlobalWorkerOptions.workerSrc = undefined;
    });

    it('configures pdf.js worker source and leaves worker mode enabled', async () => {
        const {
            PDFJS_WORKER_SRC,
            createPdfjsDocumentInit,
            getPdfjsLib,
        } = await import('@app/platform/browser-api/common');

        const pdfjsLib = await getPdfjsLib();
        const input = new Uint8Array([
            1,
            2,
            3,
        ]);
        const init = createPdfjsDocumentInit(pdfjsLib, input);

        expect(pdfjsModule.GlobalWorkerOptions.workerSrc).toBe(PDFJS_WORKER_SRC);
        expect(init).not.toHaveProperty('disableWorker');
        expect(init).toMatchObject({
            data: expect.any(Uint8Array),
            verbosity: pdfjsModule.VerbosityLevel.ERRORS,
        });
        const initData = (init as { data: Uint8Array }).data;
        expect(initData).not.toBe(input);
        expect(Array.from(initData)).toEqual(Array.from(input));
        expect(Array.from(input)).toEqual([
            1,
            2,
            3,
        ]);
    });
});
