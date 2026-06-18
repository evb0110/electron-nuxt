import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { cast } from '@tests/helpers/cast';

type THighlightPageMock = (
    textLayer: HTMLElement,
    pageMatchData: unknown,
    currentMatch?: {pageMatchIndex?: number} | null,
) => {
    elements: HTMLElement[];
    currentMatchRanges: Range[];
};

const highlightPageMock = vi.fn<THighlightPageMock>(() => ({
    elements: [],
    currentMatchRanges: [],
}));
const renderPageWordBoxesMock = vi.fn();
const clearWordBoxesMock = vi.fn();

vi.stubGlobal('DOMMatrix', class {
    a = 1;
    d = 1;
});

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfSearchHighlight', () => ({usePdfSearchHighlight: () => ({
    clearHighlights: vi.fn(),
    highlightPage: highlightPageMock,
    scrollToHighlight: vi.fn(),
    getCurrentMatchRanges: vi.fn(() => []),
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfWordBoxes', () => ({usePdfWordBoxes: () => ({
    renderPageWordBoxes: renderPageWordBoxesMock,
    clearWordBoxes: clearWordBoxesMock,
    isOcrDebugEnabled: vi.fn(() => false),
    clearOcrDebugBoxes: vi.fn(),
    renderOcrDebugBoxes: vi.fn(),
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({getOcrTextContent: vi.fn()})}));

vi.mock('@app/modules/pdf-viewer/engine/search/pdfSearchHighlightCss', () => ({
    getHighlightMode: () => 'dom',
    isHighlightDebugEnabled: () => false,
    isHighlightDebugVerboseEnabled: () => false,
}));

const { usePdfTextLayerRenderer } = await import('@app/modules/pdf-viewer/runtime/composables/pdf/usePdfTextLayerRenderer');

function domRectLike(options: {
    top: number;
    left?: number;
    width?: number;
    height?: number;
}) {
    const {
        top,
        left = 0,
        width = 80,
        height = 20,
    } = options;

    return cast<DOMRect>({
        top,
        left,
        width,
        height,
        bottom: top + height,
        right: left + width,
        x: left,
        y: top,
        toJSON: () => ({}),
    });
}

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
            cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}}),
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

        const textLayer41 = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});
        const textLayer44 = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});
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

    it('does not cache highlight refresh before the text layer is mounted', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: 0,
                pageText: '',
                searchQuery: 'roma',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 4,
                }],
            },
        ]]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 4,
            }),
            workingCopyPath: ref(null),
            effectiveScale: ref(1),
        });

        let textLayer: HTMLElement | null = null;
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [page]
                : []
        )});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).not.toHaveBeenCalled();

        textLayer = cast<HTMLElement>({dataset: {pdfTextLayerReady: 'true'}});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).toHaveBeenCalledTimes(1);
    });

    it('does not cache highlight refresh while a mounted text layer is still rendering', () => {
        const pageMatches = new Map([[
            0,
            {
                pageIndex: 0,
                pageText: 'roma',
                searchQuery: 'roma',
                matches: [{
                    matchIndex: 0,
                    start: 0,
                    end: 4,
                }],
            },
        ]]);

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch: ref({
                pageIndex: 0,
                matchIndex: 0,
                startOffset: 0,
                endOffset: 4,
            }),
            workingCopyPath: ref(null),
            effectiveScale: ref(1),
        });

        const renderingTextLayerDataset = {
            pdfTextLayerRendering: 'true',
            pdfTextLayerReady: 'false',
        };
        let textLayer = cast<HTMLElement>({dataset: renderingTextLayerDataset});
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            querySelector: (selector: string) => selector === '.text-layer' ? textLayer : null,
        });
        const root = cast<HTMLElement>({querySelectorAll: (selector: string) => (
            selector === '.page_container'
                ? [page]
                : []
        )});

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).not.toHaveBeenCalled();

        textLayer = cast<HTMLElement>({
            dataset: {pdfTextLayerReady: 'true'},
            textContent: 'roma',
            querySelector: (selector: string) => selector === 'span' ? cast<HTMLSpanElement>({}) : null,
        });

        renderer.applyAllSearchHighlights(root);

        expect(highlightPageMock).toHaveBeenCalledTimes(1);
    });

    it('refreshes same-page current highlights before measuring scroll geometry', () => {
        vi.stubGlobal('window', {getComputedStyle: () => ({
            paddingTop: '20px',
            paddingBottom: '20px',
        })});

        const oldCurrentMarkRect = domRectLike({
            top: 189,
            height: 173,
        });
        const newCurrentMarkRect = domRectLike({
            top: 1390,
            left: 882,
            width: 79,
            height: 25,
        });
        const oldCurrentMark = cast<HTMLElement>({getBoundingClientRect: () => oldCurrentMarkRect});
        const newCurrentMark = cast<HTMLElement>({getBoundingClientRect: () => newCurrentMarkRect});
        let currentMark = oldCurrentMark;

        highlightPageMock.mockImplementation((_textLayer, _pageMatchData, currentMatch) => {
            currentMark = currentMatch?.pageMatchIndex === 1
                ? newCurrentMark
                : oldCurrentMark;
            return {
                elements: [currentMark],
                currentMatchRanges: [],
            };
        });

        const pageMatches = new Map([[
            0,
            {
                pageIndex: 0,
                pageText: 'historia historia',
                searchQuery: 'historia',
                signatureToken: 'page-0-two-matches',
                matches: [
                    {
                        matchIndex: 0,
                        start: 0,
                        end: 8,
                    },
                    {
                        matchIndex: 1,
                        start: 9,
                        end: 17,
                    },
                ],
            },
        ]]);
        const currentSearchMatch = ref({
            pageIndex: 0,
            matchIndex: 0,
            pageMatchIndex: 0,
            startOffset: 0,
            endOffset: 8,
        });

        const renderer = usePdfTextLayerRenderer({
            searchPageMatches: ref(pageMatches),
            currentSearchMatch,
            workingCopyPath: ref(null),
            effectiveScale: ref(1),
        });

        const textLayer = cast<HTMLElement>({
            dataset: {pdfTextLayerReady: 'true'},
            querySelector: (selector: string) => selector === '.pdf-search-highlight--current'
                ? currentMark
                : null,
        });
        const page = cast<HTMLElement>({
            dataset: {page: '1'},
            offsetTop: 7106,
            offsetHeight: 3000,
            querySelector: (selector: string) => selector === '.text-layer'
                ? textLayer
                : null,
        });
        const root = cast<HTMLElement>({
            scrollTop: 7106,
            clientHeight: 982,
            querySelector: (selector: string) => selector === '.page_container[data-page="1"]'
                ? page
                : null,
            querySelectorAll: (selector: string) => selector === '.page_container'
                ? [page]
                : [],
            getBoundingClientRect: () => domRectLike({
                top: 94,
                width: 1200,
                height: 982,
            }),
        });

        renderer.applyPageSearchHighlights(
            page,
            textLayer,
            1,
            {} as HTMLCanvasElement,
        );
        currentSearchMatch.value = {
            pageIndex: 0,
            matchIndex: 1,
            pageMatchIndex: 1,
            startOffset: 9,
            endOffset: 17,
        };

        const didScroll = renderer.scrollToCurrentMatch(root);

        expect(didScroll).toBe(true);
        expect(highlightPageMock).toHaveBeenCalledTimes(2);
        expect(root.scrollTop).toBeGreaterThan(7900);
    });
});
