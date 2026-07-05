import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    TextContent,
    TextItem,
} from 'pdfjs-dist/types/src/display/api';
import {
    extractBrowserSearchPageData,
    extractBrowserSearchPageText,
} from '@app/platform/browser-api/extractBrowserSearchPageText';

const mocks = vi.hoisted(() => ({
    extractPdfjsWordBoxesFromOperatorList: vi.fn(),
    getPdfjsPageViewBox: vi.fn(),
}));

vi.mock('@pdf-core', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...(actual as object),
        extractPdfjsWordBoxesFromOperatorList: mocks.extractPdfjsWordBoxesFromOperatorList,
        getPdfjsPageViewBox: mocks.getPdfjsPageViewBox,
    };
});

describe('extractBrowserSearchPageText', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.extractPdfjsWordBoxesFromOperatorList.mockReturnValue([]);
        mocks.getPdfjsPageViewBox.mockReturnValue({
            pageHeight: 200,
            pageWidth: 100,
        });
    });

    it('keeps PDF.js text item offsets compatible with rendered text layers', async () => {
        const makeTextItem = (str: string, hasEOL: boolean): TextItem => ({
            str,
            hasEOL,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const textContent: TextContent = {
            items: [
                makeTextItem('alpha', true),
                makeTextItem('beta  gamma', false),
            ],
            styles: {},
            lang: null,
        };
        const cleanup = vi.fn(() => true);
        const page = {
            getTextContent: vi.fn(async () => textContent),
            cleanup,
        };

        await expect(extractBrowserSearchPageText(page)).resolves.toBe('alpha\nbeta  gamma');
        expect(page.getTextContent).toHaveBeenCalledWith({
            includeMarkedContent: true,
            disableNormalization: true,
        });
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('collapses exact repeated hidden text streams before browser search indexes the page', async () => {
        const repeatedText = 'СЛОВАРЬ\nАРАБСКОЙ ХРЕСТОМАТИИ И КОРАНУ. СОСТАВИЛЪ ПРОФ. В. ГИРГАСЪ.\n';
        const makeTextItem = (str: string): TextItem => ({
            str,
            hasEOL: false,
            dir: 'ltr',
            transform: [],
            width: 0,
            height: 0,
            fontName: 'f1',
        });
        const textContent: TextContent = {
            items: [
                makeTextItem(repeatedText),
                makeTextItem(repeatedText),
                makeTextItem(repeatedText),
            ],
            styles: {},
            lang: null,
        };
        const page = { getTextContent: vi.fn(async () => textContent) };

        await expect(extractBrowserSearchPageText(page)).resolves.toBe(repeatedText);
    });

    it('does not start text-content fallback when cancellation arrives after operator-list extraction', async () => {
        const page = {
            cleanup: vi.fn(),
            getOperatorList: vi.fn(async () => ({
                argsArray: [],
                fnArray: [],
            })),
            getTextContent: vi.fn(async () => ({
                items: [],
                styles: {},
                lang: null,
            })),
        };
        const shouldContinue = vi.fn(() => false);

        await expect(extractBrowserSearchPageData(page, {}, {shouldContinue}))
            .rejects
            .toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(page.getOperatorList).toHaveBeenCalledOnce();
        expect(page.getTextContent).not.toHaveBeenCalled();
        expect(page.cleanup).toHaveBeenCalledOnce();
    });

    it('rejects direct text extraction when cancellation arrives after getTextContent resolves', async () => {
        const page = {
            cleanup: vi.fn(),
            getTextContent: vi.fn(async () => ({
                items: [],
                styles: {},
                lang: null,
            })),
        };
        const shouldContinue = vi.fn(() => false);

        await expect(extractBrowserSearchPageText(page, {shouldContinue}))
            .rejects
            .toThrow('ERR_BROWSER_SEARCH_CANCELED');

        expect(page.getTextContent).toHaveBeenCalledOnce();
        expect(page.cleanup).toHaveBeenCalledOnce();
    });
});
