import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';

function cast<T>(value: unknown): T {
    return value as T;
}

const highlightPageMock = vi.fn(() => ({
    elements: [],
    currentMatchRanges: [],
}));
const renderPageWordBoxesMock = vi.fn();
const clearWordBoxesMock = vi.fn();

vi.stubGlobal('DOMMatrix', class {
    a = 1;
    d = 1;
});

vi.mock('@app/composables/usePdfSearchHighlight', () => ({usePdfSearchHighlight: () => ({
    clearHighlights: vi.fn(),
    highlightPage: highlightPageMock,
    scrollToHighlight: vi.fn(),
    getCurrentMatchRanges: vi.fn(() => []),
})}));

vi.mock('@app/composables/usePdfWordBoxes', () => ({usePdfWordBoxes: () => ({
    renderPageWordBoxes: renderPageWordBoxesMock,
    clearWordBoxes: clearWordBoxesMock,
    isOcrDebugEnabled: vi.fn(() => false),
    clearOcrDebugBoxes: vi.fn(),
    renderOcrDebugBoxes: vi.fn(),
})}));

vi.mock('@app/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({getOcrTextContent: vi.fn()})}));

vi.mock('@app/composables/pdfSearchHighlightCss', () => ({
    getHighlightMode: () => 'dom',
    isHighlightDebugEnabled: () => false,
    isHighlightDebugVerboseEnabled: () => false,
}));

const { usePdfTextLayerRenderer } = await import('@app/composables/pdf/usePdfTextLayerRenderer');

describe('usePdfTextLayerRenderer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        highlightPageMock.mockReturnValue({
            elements: [],
            currentMatchRanges: [],
        });
    });

    it('keeps repeated words with different geometry in fallback word-box rendering', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: 0,
                pageText: 'foo foo',
                searchQuery: 'foo',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 3,
                    words: [
                        {
                            text: 'foo',
                            x: 10,
                            y: 20,
                            width: 30,
                            height: 12,
                        },
                        {
                            text: 'foo',
                            x: 60,
                            y: 20,
                            width: 30,
                            height: 12,
                        },
                    ],
                    pageWidth: 100,
                    pageHeight: 100,
                }],
            },
        ]]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            effectiveScale: ref(1),
        });

        renderer.applyPageSearchHighlights(
            {} as HTMLElement,
            {} as HTMLElement,
            1,
            {} as HTMLCanvasElement,
        );

        expect(renderPageWordBoxesMock).toHaveBeenCalledTimes(1);
        const words = renderPageWordBoxesMock.mock.calls[0]?.[1] as Array<{
            text: string;
            x: number;
        }>;
        expect(words).toHaveLength(2);
        expect(words[0]?.x).toBe(10);
        expect(words[1]?.x).toBe(60);
    });

    it('maps applyAllSearchHighlights by mounted page numbers instead of DOM order', () => {
        const pageMatches = new Map([
            [
                40,
                {
                    pageIndex: 40,
                    pageText: '',
                    searchQuery: 'what',
                    matches: [{
                        matchIndex: 0,
                        start: 0,
                        end: 4,
                    }],
                },
            ],
            [
                43,
                {
                    pageIndex: 43,
                    pageText: '',
                    searchQuery: 'what',
                    matches: [{
                        matchIndex: 1,
                        start: 10,
                        end: 14,
                    }],
                },
            ],
        ]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref(null),
            workingCopyPath: ref(null),
            effectiveScale: ref(1),
        });

        const textLayer41 = cast<HTMLElement>({});
        const textLayer44 = cast<HTMLElement>({});
        const page41 = cast<HTMLElement>({
            dataset: {page: '41'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer41 : null,
        });
        const page44 = cast<HTMLElement>({
            dataset: {page: '44'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer44 : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [
                    page41,
                    page44,
                ]
                : []
        )});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).toHaveBeenCalledTimes(2);
        const firstCallPageMatches = highlightPageMock.mock.calls
            .at(0)
            ?.at(1) as {pageIndex: number} | undefined;
        const secondCallPageMatches = highlightPageMock.mock.calls
            .at(1)
            ?.at(1) as {pageIndex: number} | undefined;
        expect(firstCallPageMatches?.pageIndex).toBe(40);
        expect(secondCallPageMatches?.pageIndex).toBe(43);
    });
});
