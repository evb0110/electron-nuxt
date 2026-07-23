import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    applyPageMetadataRemap,
    remapPageMetadata,
} from '@electron/features/page-ops/main/pageMetadataRemap';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

const mocks = vi.hoisted(() => ({runNativeToolCommand: vi.fn()}));

vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: () => false,
    resolveNativePageOpsPath: () => '/mock/evb-pdf-page-ops',
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));

const bookmark = (title: string, pageIndex: number | null, items: IPdfBookmarkEntry[] = []): IPdfBookmarkEntry => ({
    title,
    pageIndex,
    namedDest: pageIndex === null ? 'named' : null,
    bold: false,
    italic: false,
    color: null,
    items,
});

describe('page metadata remap', () => {
    beforeEach(() => {
        mocks.runNativeToolCommand.mockReset();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
    });

    it('remaps exact labels and bookmark destinations through reorder/delete/insert', () => {
        const result = remapPageMetadata({
            pageLabels: [
                'i',
                'ii',
                '1',
                '2',
            ],
            bookmarks: [
                bookmark('deleted parent', 1, [bookmark('surviving child', 3)]),
                bookmark('first', 0),
                bookmark('named', null),
            ],
            untitledBookmarkLabel: 'Untitled',
        }, {
            previousPageCount: 4,
            pages: [
                {fromPageNumber: 4},
                {insertedId: 'inserted'},
                {fromPageNumber: 1},
                {fromPageNumber: 3},
            ],
        });

        expect(result.pageLabels.ranges.map(range => range.prefix)).toEqual([
            '2',
            '2',
            'i',
            '1',
        ]);
        expect(result.bookmarks.items).toEqual([
            expect.objectContaining({
                title: 'surviving child',
                pageIndex: 0,
            }),
            expect.objectContaining({
                title: 'first',
                pageIndex: 2,
            }),
            expect.objectContaining({
                title: 'named',
                pageIndex: null,
                namedDest: 'named',
            }),
        ]);
    });

    it('uses explicit tail-only validation for the metadata-only append', async () => {
        await applyPageMetadataRemap({
            workingCopyPath: '/managed/working.pdf',
            delta: {
                previousPageCount: 1,
                pages: [{fromPageNumber: 1}],
            },
            metadataSnapshot: {
                pageLabels: ['1'],
                bookmarks: [],
                untitledBookmarkLabel: 'Untitled',
            },
            signal: new AbortController().signal,
            cancelGroup: 'page-remap-test',
        });

        const args = mocks.runNativeToolCommand.mock.calls[0]?.[1] as string[];
        expect(args.slice(-3)).toEqual([
            '--append',
            '--incremental-validation',
            'tail-only',
        ]);
    });
});
