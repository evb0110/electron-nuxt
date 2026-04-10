import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PageViewport } from 'pdfjs-dist';

const mockDocuments = {
    fileExists: vi.fn(),
    readTextFile: vi.fn(),
};
vi.mock('@app/utils/platform-documents', () => ({ getDocumentsCapability: () => mockDocuments }));

function createViewport(): PageViewport {
    return {
        viewBox: [
            0,
            0,
            100,
            100,
        ],
        userUnit: 1,
        width: 100,
        height: 100,
        scale: 1,
        rotation: 0,
        offsetX: 0,
        offsetY: 0,
        transform: [
            1,
            0,
            0,
            1,
            0,
            0,
        ],
        rawDims: {
            pageWidth: 100,
            pageHeight: 100,
        },
        clone() {
            return createViewport();
        },
        convertToViewportPoint() {
            return [
                0,
                0,
            ];
        },
        convertToViewportRectangle() {
            return [
                0,
                0,
                0,
                0,
            ];
        },
        convertToPdfPoint() {
            return [
                0,
                0,
            ];
        },
    };
}

describe('useOcrTextContent', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mockDocuments.fileExists.mockResolvedValue(true);
        mockDocuments.readTextFile.mockImplementation(async (path: string) => {
            if (path.endsWith('manifest.json')) {
                return JSON.stringify({
                    version: 2,
                    createdAt: 1,
                    source: {pdfPath: '/tmp/doc.pdf'},
                    pageCount: 1,
                    pageBox: 'crop',
                    ocr: {
                        engine: 'tesseract',
                        languages: ['eng'],
                        renderDpi: 300,
                    },
                    pages: {1: {path: 'page-1.json'}},
                });
            }
            if (path.endsWith('page-1.json')) {
                return JSON.stringify({
                    pageNumber: 1,
                    rotation: 0,
                    render: {
                        dpi: 300,
                        imagePx: {
                            w: 100,
                            h: 100,
                        },
                    },
                    text: 'hello world',
                    words: [{
                        text: 'hello',
                        x: 10,
                        y: 10,
                        width: 20,
                        height: 10,
                    }],
                });
            }
            throw new Error(`Unexpected path: ${path}`);
        });
        vi.stubGlobal('document', {createElement: () => ({getContext: () => ({
            font: '',
            measureText: () => ({
                actualBoundingBoxAscent: 80,
                actualBoundingBoxDescent: 20,
            }),
        })})});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shares manifest and page caches across composable callers and clears by path', async () => {
        const {useOcrTextContent} = await import('@app/composables/pdf/useOcrTextContent');

        const first = useOcrTextContent();
        const second = useOcrTextContent();
        const viewport = createViewport();

        await expect(first.hasOcrData('/tmp/doc.pdf')).resolves.toBe(true);
        await expect(first.getOcrTextContent('/tmp/doc.pdf', 1, viewport)).resolves.not.toBeNull();
        await expect(second.getOcrTextContent('/tmp/doc.pdf', 1, viewport)).resolves.not.toBeNull();

        expect(mockDocuments.fileExists).toHaveBeenCalledTimes(2);
        expect(mockDocuments.readTextFile).toHaveBeenCalledTimes(2);

        first.clearCache('/tmp/doc.pdf');

        await expect(second.hasOcrData('/tmp/doc.pdf')).resolves.toBe(true);
        expect(mockDocuments.fileExists).toHaveBeenCalledTimes(3);
        expect(mockDocuments.readTextFile).toHaveBeenCalledTimes(3);
    });
});
