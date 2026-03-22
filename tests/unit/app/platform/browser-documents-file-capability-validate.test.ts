import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';

const pdfjsModule = vi.hoisted(() => ({
    GlobalWorkerOptions: {},
    VerbosityLevel: {ERRORS: 3},
    getDocument: vi.fn(),
}));

vi.mock('pdfjs-dist', () => pdfjsModule);

describe('createBrowserDocumentsFileCapability validation', () => {
    beforeEach(() => {
        vi.resetModules();
        pdfjsModule.getDocument.mockReset();
    });

    it('validates pdf bytes with pdf.js instead of pdf-lib parsing', async () => {
        const destroy = vi.fn(async () => {});
        pdfjsModule.getDocument.mockReturnValue({promise: Promise.resolve({destroy})});

        const loadSpy = vi.spyOn(PDFDocument, 'load');
        const { createBrowserDocumentsFileCapability } = await import('@app/platform/browser-api/documents-file-capability');
        const capability = createBrowserDocumentsFileCapability({ clearSearchCaches: () => {} });

        await expect(
            capability.validatePdfData(new Uint8Array([
                1,
                2,
                3,
            ])),
        ).resolves.toEqual({
            isValid: true,
            tool: 'browser',
            errors: [],
            warnings: [],
        });

        expect(pdfjsModule.getDocument).toHaveBeenCalledTimes(1);
        expect(loadSpy).not.toHaveBeenCalled();
        expect(destroy).toHaveBeenCalledTimes(1);
    });
});
