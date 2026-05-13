import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    TextContent,
    TextItem,
} from 'pdfjs-dist/types/src/display/api';
import { extractBrowserSearchPageText } from '@app/platform/browser-api/browserSearchText';

describe('extractBrowserSearchPageText', () => {
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
});
