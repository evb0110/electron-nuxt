import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { PageViewport } from 'pdfjs-dist';
import {
    createOcrDocumentTextCatalogFixture,
    OCR_CATALOG_FIXTURE_PATH,
    OCR_CATALOG_FIXTURE_REVISION,
} from '@tests/helpers/ocrDocumentTextCatalogFixture';

const state = vi.hoisted(() => ({artifacts: new Map<string, unknown>()}));
const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(async () => undefined),
    extractTextFromPdf: vi.fn(async () => []),
    extractTextWithPdfjs: vi.fn(async () => []),
    extractTextWithPdfjsWordBoxes: vi.fn(async () => []),
    persistCompactSearchIndexBestEffort: vi.fn(async () => undefined),
    ensureNativeSearchIndexBestEffort: vi.fn(async () => undefined),
    resolveCatalogViaCapability: vi.fn(),
}));

function relativeArtifactPath(path: string) {
    const marker = '.ocr/';
    const index = path.indexOf(marker);
    return index < 0 ? path : path.slice(index + marker.length);
}

vi.mock('fs', () => ({existsSync: (path: string) => state.artifacts.has(relativeArtifactPath(path))}));
vi.mock('fs/promises', () => ({
    readFile: async (path: string) => {
        const value = state.artifacts.get(relativeArtifactPath(path));
        if (value === undefined) throw new Error('ENOENT');
        return JSON.stringify(value);
    },
    rm: vi.fn(async () => undefined),
    stat: vi.fn(async () => ({size: 1})),
    writeFile: vi.fn(async () => undefined),
}));
vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {warn: vi.fn()}}));
vi.mock('@app/utils/getOcrCapability', () => ({getOcrCapability: () => ({resolveDocumentTextCatalog: (...args: unknown[]) => mocks.resolveCatalogViaCapability(...args)})}));
vi.mock('@electron/search/extractTextFromPdf', () => ({extractTextFromPdf: mocks.extractTextFromPdf}));
vi.mock('@electron/search/extractTextWithPdfjs', () => ({
    extractTextWithPdfjs: mocks.extractTextWithPdfjs,
    extractTextWithPdfjsWordBoxes: mocks.extractTextWithPdfjsWordBoxes,
}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: (path: string) => `${path}.tmp`,
}));
vi.mock('@electron/search/searchIndexSidecar', () => ({
    COMPACT_SEARCH_INDEX_SOURCE_KIND_OCR_TEXT_LAYER: 1,
    persistCompactSearchIndexBestEffort: mocks.persistCompactSearchIndexBestEffort,
}));
vi.mock('@electron/search/nativeSearchIndex', () => ({ensureNativeSearchIndexBestEffort: mocks.ensureNativeSearchIndexBestEffort}));
vi.mock('@electron/file-access/documentRevisionSidecar', () => ({
    assertWorkingCopyRevisionSidecarCurrent: vi.fn(async () => undefined),
    reconcileWorkingCopyRevisionSidecarJournal: vi.fn(async () => null),
}));
vi.mock('@electron/file-access/workingCopyStore', () => ({normalizePathForLookup: (path: string) => path}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
})}));

const {loadDocumentTextCatalogPages} = await import('@app/utils/ocr/loadOcrText');
const {useOcrTextContent} = await import('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent');
const {buildSearchIndex} = await import('@electron/search/indexBuilder');
const {resolveDocumentTextCatalogSnapshot} = await import('@electron/ocr/documentTextCatalog');

function createViewport(): PageViewport {
    return {
        viewBox: [
            0,
            0,
            300,
            400,
        ],
        userUnit: 1,
        width: 300,
        height: 400,
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
            pageWidth: 300,
            pageHeight: 400,
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

function comparablePages(pages: ReadonlyArray<{
    pageNumber: number;
    text: string
}>) {
    return pages.map(page => ({
        pageNumber: page.pageNumber,
        text: page.text.replace(/\s+/gu, ' ').trim(),
    }));
}

describe('DocumentTextCatalog reader agreement', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.artifacts.clear();
        useOcrTextContent().clearCache();
        mocks.resolveCatalogViaCapability.mockImplementation(resolveDocumentTextCatalogSnapshot);
    });

    it('returns identical page text through viewer, search, and export readers', async () => {
        const fixture = createOcrDocumentTextCatalogFixture([
            {
                pageNumber: 1,
                text: 'native-looking first page',
            },
            {
                pageNumber: 2,
                text: 'EVB OCR second page',
            },
            {
                pageNumber: 3,
                text: 'foreign-looking third page',
            },
        ]);
        state.artifacts = new Map(fixture.artifacts);

        const exportPages = await loadDocumentTextCatalogPages(fixture.path, fixture.revision);
        const viewer = useOcrTextContent();
        const viewerPages = await Promise.all([
            1,
            2,
            3,
        ].map(async pageNumber => {
            const content = await viewer.getOcrTextContent(
                fixture.path,
                fixture.revision,
                pageNumber,
                createViewport(),
            );
            return {
                pageNumber,
                text: content?.items.map(item => item.str).join(' ') ?? '',
            };
        }));
        const search = await buildSearchIndex(fixture.path, [], {
            documentRevision: fixture.revision,
            pageCount: fixture.manifest.pageCount,
        });
        const canonical = await resolveDocumentTextCatalogSnapshot(
            fixture.path,
            fixture.revision,
            fixture.manifest.pageCount,
        );

        const expected = comparablePages(exportPages ?? []);
        expect(comparablePages(viewerPages)).toEqual(expected);
        expect(comparablePages(search.pages)).toEqual(expected);
        expect(comparablePages(canonical.pages)).toEqual(expected);
        expect(mocks.extractTextFromPdf).not.toHaveBeenCalled();
        expect(mocks.extractTextWithPdfjs).not.toHaveBeenCalled();
    });

    it.each([
        [
            'stale manifest revision',
            (artifacts: Map<string, unknown>) => {
                const manifest = structuredClone(artifacts.get('manifest.json')) as {documentRevision: {token: string}};
                manifest.documentRevision.token = 'stale-revision';
                artifacts.set('manifest.json', manifest);
            },
        ],
        [
            'swapped page identity',
            (artifacts: Map<string, unknown>) => {
                const page = structuredClone(artifacts.get('page-0001.json')) as {pageNumber: number};
                page.pageNumber = 2;
                artifacts.set('page-0001.json', page);
            },
        ],
        [
            'zero render width',
            (artifacts: Map<string, unknown>) => {
                const page = structuredClone(artifacts.get('page-0001.json')) as {render: {imagePx: {w: number}}};
                page.render.imagePx.w = 0;
                artifacts.set('page-0001.json', page);
            },
        ],
    ])('strict readers refuse %s', async (_label, mutate) => {
        const fixture = createOcrDocumentTextCatalogFixture([{
            pageNumber: 1,
            text: 'must not leak',
        }]);
        mutate(fixture.artifacts);
        state.artifacts = new Map(fixture.artifacts);

        const exportPages = await loadDocumentTextCatalogPages(OCR_CATALOG_FIXTURE_PATH, OCR_CATALOG_FIXTURE_REVISION);
        const viewerContent = await useOcrTextContent().getOcrTextContent(
            OCR_CATALOG_FIXTURE_PATH,
            OCR_CATALOG_FIXTURE_REVISION,
            1,
            createViewport(),
        );
        const search = await buildSearchIndex(OCR_CATALOG_FIXTURE_PATH, [], {
            documentRevision: OCR_CATALOG_FIXTURE_REVISION,
            pageCount: 1,
        });

        expect(exportPages?.some(page => page.text.includes('must not leak')) ?? false).toBe(false);
        expect(viewerContent?.items.some(item => item.str.includes('must not leak')) ?? false).toBe(false);
        expect(search.pages.some(page => page.text.includes('must not leak'))).toBe(false);
    });
});
