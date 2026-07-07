import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    readFile: vi.fn(),
    stat: vi.fn(),
    getDocument: vi.fn(),
    loadingDestroy: vi.fn(),
    docDestroy: vi.fn(),
    OPS: {
        save: 10,
        restore: 11,
        transform: 12,
        beginText: 31,
        endText: 32,
        setCharSpacing: 33,
        setWordSpacing: 34,
        setHScale: 35,
        setLeading: 36,
        setFont: 37,
        moveText: 40,
        setLeadingMoveText: 41,
        setTextMatrix: 42,
        nextLine: 43,
        showText: 44,
        showSpacedText: 45,
        nextLineShowText: 46,
        nextLineSetSpacingShowText: 47,
    },
}));

vi.mock('@electron/search/domPolyfill', () => ({}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({debug: vi.fn()})}));

vi.mock('fs/promises', () => ({
    readFile: mocks.readFile,
    stat: mocks.stat,
}));

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    getDocument: mocks.getDocument,
    GlobalWorkerOptions: { workerSrc: '' },
    OPS: mocks.OPS,
    VerbosityLevel: { ERRORS: 0 },
}));

describe('extractTextWithPdfjs cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readFile.mockResolvedValue(Buffer.from('pdf'));
        mocks.stat.mockResolvedValue({size: 3});
        mocks.loadingDestroy.mockResolvedValue(undefined);
        mocks.docDestroy.mockResolvedValue(undefined);
    });

    it('returns AbortError immediately when signal is already aborted', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/extractTextWithPdfjs');
        const controller = new AbortController();
        controller.abort();

        await expect(
            extractTextWithPdfjs('/tmp/file.pdf', {signal: controller.signal}),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.readFile).not.toHaveBeenCalled();
        expect(mocks.getDocument).not.toHaveBeenCalled();
    });

    it('aborts pending loading task and rejects with AbortError', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/extractTextWithPdfjs');
        const controller = new AbortController();

        mocks.getDocument.mockReturnValue({
            promise: new Promise(() => {
                // Cancellation should reject before loading completes.
            }),
            destroy: mocks.loadingDestroy,
        });

        const extraction = extractTextWithPdfjs('/tmp/file.pdf', {signal: controller.signal});
        await vi.waitFor(() => {
            expect(mocks.getDocument).toHaveBeenCalledOnce();
        });
        controller.abort();

        await expect(extraction).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.loadingDestroy).toHaveBeenCalledOnce();
    });

    it('emits each page as soon as pdfjs text extraction finishes it', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/extractTextWithPdfjs');
        const pageOne = {getTextContent: vi.fn().mockResolvedValue({items: [{
            str: 'Hello',
            hasEOL: true,
        }]})};
        const pageTwo = {getTextContent: vi.fn().mockResolvedValue({items: [{
            str: 'World',
            hasEOL: false,
        }]})};
        const doc = {
            numPages: 2,
            getPage: vi.fn(async (pageNumber: number) => pageNumber === 1 ? pageOne : pageTwo),
            destroy: mocks.docDestroy,
        };
        const onPageText = vi.fn();

        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve(doc),
            destroy: mocks.loadingDestroy,
        });

        const result = await extractTextWithPdfjs('/tmp/file.pdf', {
            collectPages: true,
            onPageText,
        });

        expect(onPageText).toHaveBeenNthCalledWith(1, {
            pageNumber: 1,
            text: 'Hello\n',
        });
        expect(onPageText).toHaveBeenNthCalledWith(2, {
            pageNumber: 2,
            text: 'World',
        });
        expect(result).toEqual([
            {
                pageNumber: 1,
                text: 'Hello\n',
            },
            {
                pageNumber: 2,
                text: 'World',
            },
        ]);
        expect(mocks.docDestroy).toHaveBeenCalledOnce();
    });

    it('collapses exact repeated hidden text streams before emitting page text', async () => {
        const { extractTextWithPdfjs } = await import('@electron/search/extractTextWithPdfjs');
        const repeatedText = 'СЛОВАРЬ\nАРАБСКОЙ ХРЕСТОМАТИИ И КОРАНУ. СОСТАВИЛЪ ПРОФ. В. ГИРГАСЪ.\n';
        const pageOne = {getTextContent: vi.fn().mockResolvedValue({items: [
            {
                str: repeatedText,
                hasEOL: false,
            },
            {
                str: repeatedText,
                hasEOL: false,
            },
            {
                str: repeatedText,
                hasEOL: false,
            },
        ]})};
        const doc = {
            numPages: 1,
            getPage: vi.fn(async () => pageOne),
            destroy: mocks.docDestroy,
        };
        const onPageText = vi.fn();

        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve(doc),
            destroy: mocks.loadingDestroy,
        });

        await expect(extractTextWithPdfjs('/tmp/file.pdf', {
            collectPages: true,
            onPageText,
        })).resolves.toEqual([{
            pageNumber: 1,
            text: repeatedText,
        }]);
        expect(onPageText).toHaveBeenCalledWith({
            pageNumber: 1,
            text: repeatedText,
        });
    });

    it('extracts pdfjs operator-list word boxes from nested text matrices', async () => {
        const { extractTextWithPdfjsWordBoxes } = await import('@electron/search/extractTextWithPdfjs');
        const pageOne = {
            view: [
                0,
                0,
                424,
                640.4,
            ],
            rotate: 90,
            getOperatorList: vi.fn().mockResolvedValue({
                fnArray: [
                    mocks.OPS.beginText,
                    mocks.OPS.setTextMatrix,
                    mocks.OPS.setFont,
                    mocks.OPS.setHScale,
                    mocks.OPS.showText,
                    mocks.OPS.endText,
                ],
                argsArray: [
                    null,
                    [new Float32Array([
                        1,
                        0,
                        0,
                        1,
                        74.6,
                        259.4,
                    ])],
                    [
                        'g_d0_f2',
                        10,
                    ],
                    [110.286],
                    [Array.from('История ').map(char => ({
                        unicode: char,
                        width: 500,
                        isSpace: false,
                    }))],
                    null,
                ],
            }),
        };
        const doc = {
            numPages: 1,
            getPage: vi.fn(async () => pageOne),
            destroy: mocks.docDestroy,
        };

        mocks.getDocument.mockReturnValue({
            promise: Promise.resolve(doc),
            destroy: mocks.loadingDestroy,
        });

        const result = await extractTextWithPdfjsWordBoxes('/tmp/file.pdf', { collectPages: true });

        expect(result[0]?.text).toBe('История \n');
        expect(result[0]?.words[0]).toMatchObject({
            text: 'История',
            height: 10,
        });
        expect(result[0]?.words[0]?.x).toBeCloseTo(74.6, 4);
        expect(result[0]?.words[0]?.y).toBeCloseTo(371, 4);
        expect(result[0]?.words[0]?.width).toBeCloseTo(38.6001, 4);
        expect(result[0]?.rotation).toBe(90);
    });
});
