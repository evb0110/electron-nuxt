import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import {requireDocumentRevisionToken} from '@contracts';
import type { IOcrWord } from '@contracts/shared';

const resolveDocumentTextCatalog = vi.hoisted(() => vi.fn());
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({resolveDocumentTextCatalog})}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));

const TEST_DOCUMENT_REVISION = requireDocumentRevisionToken('revision-token');

function createSnapshot(words: IOcrWord[]) {
    return {
        documentRevision: TEST_DOCUMENT_REVISION,
        pageCount: 1,
        pages: [{
            pageNumber: 1,
            text: words.map(word => word.text).join(' '),
            words,
            source: 'evb-ocr',
            languages: ['eng'],
            render: {
                dpi: 300,
                imagePx: {
                    w: 100,
                    h: 100,
                },
            },
            contentDigest: 'page-digest',
        }],
        contentDigest: 'snapshot-digest',
    };
}

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
        clone: createViewport,
        convertToViewportPoint: () => [
            0,
            0,
        ],
        convertToViewportRectangle: () => [
            0,
            0,
            0,
            0,
        ],
        convertToPdfPoint: () => [
            0,
            0,
        ],
    };
}

describe('useOcrTextContent', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        resolveDocumentTextCatalog.mockResolvedValue(createSnapshot([{
            text: 'hello',
            x: 10,
            y: 10,
            width: 20,
            height: 10,
        }]));
        vi.stubGlobal('document', {createElement: () => ({getContext: () => ({
            font: '',
            measureText: () => ({
                actualBoundingBoxAscent: 80,
                actualBoundingBoxDescent: 20,
            }),
        })})});
    });

    afterEach(() => vi.unstubAllGlobals());

    it('shares canonical snapshots across composable callers and clears by path', async () => {
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const first = useOcrTextContent();
        const second = useOcrTextContent();

        await expect(first.hasOcrData('/tmp/doc.pdf', TEST_DOCUMENT_REVISION)).resolves.toBe(true);
        await expect(first.getOcrTextContent('/tmp/doc.pdf', TEST_DOCUMENT_REVISION, 1, createViewport())).resolves.not.toBeNull();
        await expect(second.getOcrTextContent('/tmp/doc.pdf', TEST_DOCUMENT_REVISION, 1, createViewport())).resolves.not.toBeNull();
        expect(resolveDocumentTextCatalog).toHaveBeenCalledTimes(1);

        first.clearCache('/tmp/doc.pdf');
        await expect(second.hasOcrData('/tmp/doc.pdf', TEST_DOCUMENT_REVISION)).resolves.toBe(true);
        expect(resolveDocumentTextCatalog).toHaveBeenCalledTimes(2);
    });

    it('uses the visual line box when OCR words in the same line have different heights', async () => {
        resolveDocumentTextCatalog.mockResolvedValue(createSnapshot([
            {
                text: 'small',
                x: 10,
                y: 20,
                width: 20,
                height: 10,
            },
            {
                text: 'TALL',
                x: 35,
                y: 12,
                width: 25,
                height: 30,
            },
        ]));
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const textContent = await useOcrTextContent().getOcrTextContent(
            '/tmp/mixed.pdf', TEST_DOCUMENT_REVISION, 1, createViewport(),
        );

        expect(textContent?.items).toHaveLength(2);
        expect(textContent?.items[0]?.height).toBe(30);
        expect(textContent?.items[1]?.transform[3]).toBe(30);
    });

    it('reuses the resolved ascent ratio for all OCR text items', async () => {
        const createElement = vi.fn(() => ({getContext: () => null}));
        vi.stubGlobal('document', {createElement});
        resolveDocumentTextCatalog.mockResolvedValue(createSnapshot([
            {
                text: 'hello',
                x: 10,
                y: 10,
                width: 20,
                height: 10,
            },
            {
                text: 'world',
                x: 35,
                y: 10,
                width: 20,
                height: 10,
            },
        ]));
        const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
        const textContent = await useOcrTextContent().getOcrTextContent(
            '/tmp/fallback.pdf', TEST_DOCUMENT_REVISION, 1, createViewport(),
        );

        expect(textContent?.items).toHaveLength(2);
        expect(textContent?.styles['ocr-sans']?.ascent).toBe(0.8);
        expect(createElement).toHaveBeenCalledTimes(1);
    });
});
