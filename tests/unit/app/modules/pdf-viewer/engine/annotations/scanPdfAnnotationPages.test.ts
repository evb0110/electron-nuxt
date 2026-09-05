import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IPdfAnnotationIndexPageRead,
    IPdfAnnotationIndexReader,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/createPdfAnnotationIndexAdapter';
import {scanPdfAnnotationPages} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/scanPdfAnnotationPages';
import type {
    IPdfCommentSummaryDeps,
    IPdfPageAnnotationBundle,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import {computeSummaryStableKey} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import type {
    IAnnotationCommentSummary,
    ILinkAnnotation,
} from '@app/types/annotations';
import {requirePageNumber} from '@contracts/pageNumbers';

const collectPagePdfSnapshotEntries = vi.hoisted(() => vi.fn());

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPagePdfSnapshotEntries', () => ({collectPagePdfSnapshotEntries}));

function createEmptyPageBundle(): IPdfPageAnnotationBundle {
    return {
        annotations: [],
        pageRotation: 0,
        pageView: [
            0,
            0,
            100,
            100,
        ],
    };
}

function createReader(
    readPage: (
        pageIndex: number,
    ) => IPdfAnnotationIndexPageRead | Promise<IPdfAnnotationIndexPageRead>,
): IPdfAnnotationIndexReader {
    return {
        readPage,
        readPageNames: vi.fn(async pageIndex => (await readPage(pageIndex)).names),
        cancel: vi.fn(async () => {}),
        release: vi.fn(async () => {}),
    };
}

function createSummaryDeps(): IPdfCommentSummaryDeps {
    return {
        computeStableKey: computeSummaryStableKey,
        resolveKindLabel: vi.fn(() => 'Annotation'),
    };
}

async function scan(
    nativeIndexReader: IPdfAnnotationIndexReader | null,
    pageOrder: Iterable<number>,
    loadPage: (pageNumber: number, names: ReadonlyMap<string, string> | null) => Promise<IPdfPageAnnotationBundle | null>,
    onFirstPageCollected = vi.fn(),
) {
    const comments: IAnnotationCommentSummary[] = [];
    const links: ILinkAnnotation[] = [];
    const onNativeIndexReadFailure = vi.fn();
    const waitForIdle = vi.fn(async () => {});
    const result = await scanPdfAnnotationPages({
        pageOrder: Array.from(pageOrder, pageNumber => requirePageNumber(pageNumber)),
        nativeIndexReader,
        annotationNamesByPage: null,
        comments,
        links,
        summaryDeps: createSummaryDeps(),
        loadPage,
        waitForIdle,
        isCanceled: () => false,
        onNativeIndexReadFailure,
        onFirstPageCollected,
    });
    return {
        comments,
        links,
        onFirstPageCollected,
        onNativeIndexReadFailure,
        result,
        waitForIdle,
    };
}

describe('scanPdfAnnotationPages', () => {
    beforeEach(() => {
        collectPagePdfSnapshotEntries.mockReset();
    });

    it('skips PDF.js page loading for native pages proven empty', async () => {
        const readPage = vi.fn(async () => ({
            hasAnnotations: false,
            names: new Map<string, string>(),
        }));
        const loadPage = vi.fn(async () => createEmptyPageBundle());
        const onFirstPageCollected = vi.fn();

        const {
            onNativeIndexReadFailure,
            result,
            waitForIdle,
        } = await scan(
            createReader(readPage),
            [
                1,
                2,
            ],
            loadPage,
            onFirstPageCollected,
        );

        expect(result).toEqual({
            omissions: new Set(),
            visitedPageCount: 2,
            failedPageCount: 0,
        });
        expect(readPage).toHaveBeenCalledWith(0);
        expect(readPage).toHaveBeenCalledWith(1);
        expect(loadPage).not.toHaveBeenCalled();
        expect(collectPagePdfSnapshotEntries).not.toHaveBeenCalled();
        expect(waitForIdle).not.toHaveBeenCalled();
        expect(onFirstPageCollected).toHaveBeenCalledWith({
            pageNumber: 1,
            comments: [],
            links: [],
            failed: false,
        });
        expect(onNativeIndexReadFailure).not.toHaveBeenCalled();
    });

    it('does not create an async turn for every synchronously proven-empty page', async () => {
        const trace: string[] = [];
        const readPage = vi.fn((pageIndex: number) => {
            trace.push(`read:${String(pageIndex)}`);
            return {
                hasAnnotations: false,
                names: new Map<string, string>(),
            };
        });
        const pending = scan(
            createReader(readPage),
            [
                1,
                2,
            ],
            vi.fn(async () => createEmptyPageBundle()),
        );
        trace.push('after-call');

        expect(trace).toEqual([
            'read:0',
            'read:1',
            'after-call',
        ]);
        await expect(pending).resolves.toMatchObject({result: {
            visitedPageCount: 2,
            failedPageCount: 0,
        }});
    });

    it('loads pages marked by unnamed, link, and direct annotation entries', async () => {
        const pageReads: IPdfAnnotationIndexPageRead[] = [
            {
                hasAnnotations: true,
                names: new Map([[
                    '11R',
                    'named-note',
                ]]),
            },
            {
                hasAnnotations: true,
                names: new Map(),
            },
            {
                hasAnnotations: true,
                names: new Map(),
            },
        ];
        const readPage = vi.fn(async (pageIndex: number) => pageReads[pageIndex]!);
        const loadPage = vi.fn(async () => createEmptyPageBundle());

        const {waitForIdle} = await scan(
            createReader(readPage),
            [
                1,
                2,
                3,
            ],
            loadPage,
        );

        expect(loadPage).toHaveBeenCalledTimes(3);
        expect(loadPage).toHaveBeenNthCalledWith(
            1,
            1,
            new Map([[
                '11R',
                'named-note',
            ]]),
        );
        expect(loadPage).toHaveBeenNthCalledWith(
            2,
            2,
            new Map(),
        );
        expect(waitForIdle).toHaveBeenCalledTimes(2);
        expect(loadPage).toHaveBeenNthCalledWith(
            3,
            3,
            new Map(),
        );
    });

    it('falls back to loading pages after a native read failure', async () => {
        const readPage = vi.fn(async () => {
            throw new Error('native index read failed');
        });
        const loadPage = vi.fn(async () => createEmptyPageBundle());

        const {
            onNativeIndexReadFailure,
            result,
            waitForIdle,
        } = await scan(
            createReader(readPage),
            [
                1,
                2,
            ],
            loadPage,
        );

        expect(result).toEqual({
            omissions: new Set(),
            visitedPageCount: 2,
            failedPageCount: 0,
        });
        expect(onNativeIndexReadFailure).toHaveBeenCalledOnce();
        expect(readPage).toHaveBeenCalledOnce();
        expect(loadPage).toHaveBeenCalledTimes(2);
        expect(waitForIdle).toHaveBeenCalledOnce();
    });

    it('reports a typed identity refusal for a browser Stamp without a bounded NM read', async () => {
        const loadPage = vi.fn(async (): Promise<IPdfPageAnnotationBundle> => ({
            ...createEmptyPageBundle(),
            annotations: [{
                id: '44R',
                subtype: 'Stamp',
                rect: [
                    10,
                    10,
                    20,
                    20,
                ],
            }],
        }));

        const {result} = await scan(null, [1], loadPage);

        expect(result?.omissions).toEqual(new Set(['annotation-name-unavailable']));
    });
});
