import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    SEARCH_JS_WHOLE_VALUE_MAX_BYTES,
    SEARCH_XLARGE_PAGE_COUNT_THRESHOLD,
    classifyXlargeSearchPath,
    ensureXlargeSearchIndex,
    resetXlargeSearchIndexBuilds,
} from '@electron/search/xlargeSearchRouting';
import {requireDocumentRevisionToken} from '@contracts';

const mocks = vi.hoisted(() => ({buildXlargeSearchIndex: vi.fn()}));

vi.mock('@electron/search/xlargeIndexBuilder', () => ({buildXlargeSearchIndex: mocks.buildXlargeSearchIndex}));

const BUILD_RESULT = {
    indexPath: '/tmp/document.pdf.index.evb-search-v2.bin',
    documentRevision: requireDocumentRevisionToken('revision-token'),
    pageCount: 3,
    pagesScanned: 3,
    pagesWritten: 3,
    textBytes: 10,
    truncated: false,
    complete: true,
};

describe('xlarge search routing', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        resetXlargeSearchIndexBuilds();
    });

    it('uses size and page count as routing hints without rejecting a large document', () => {
        expect(classifyXlargeSearchPath({
            pathSizeBytes: SEARCH_JS_WHOLE_VALUE_MAX_BYTES,
            pageCount: SEARCH_XLARGE_PAGE_COUNT_THRESHOLD,
        })).toMatchObject({
            isXlarge: false,
            reasons: [],
        });
        expect(classifyXlargeSearchPath({pathSizeBytes: SEARCH_JS_WHOLE_VALUE_MAX_BYTES + 1})).toMatchObject({
            isXlarge: true,
            reasons: ['path-size'],
        });
        expect(classifyXlargeSearchPath({pageCount: SEARCH_XLARGE_PAGE_COUNT_THRESHOLD + 1})).toMatchObject({
            isXlarge: true,
            reasons: ['page-count'],
        });
    });

    it('coalesces same-revision builds while allowing one caller to cancel', async () => {
        let resolveBuild!: (result: typeof BUILD_RESULT) => void;
        let buildSignal!: AbortSignal;
        mocks.buildXlargeSearchIndex.mockImplementation(async (options: {signal: AbortSignal}) => {
            buildSignal = options.signal;
            return new Promise(resolve => {
                resolveBuild = resolve;
            });
        });
        const firstController = new AbortController();
        const first = ensureXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
            signal: firstController.signal,
        });
        const second = ensureXlargeSearchIndex({
            pdfPath: '/tmp/document.pdf',
            documentRevision: requireDocumentRevisionToken('revision-token'),
            pageCount: 3,
        });

        await vi.waitFor(() => expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce());
        firstController.abort(new Error('first caller cancelled'));
        await expect(first).rejects.toThrow('first caller cancelled');
        expect(buildSignal.aborted).toBe(false);

        resolveBuild(BUILD_RESULT);
        await expect(second).resolves.toEqual(BUILD_RESULT);
        expect(mocks.buildXlargeSearchIndex).toHaveBeenCalledOnce();
    });
});
