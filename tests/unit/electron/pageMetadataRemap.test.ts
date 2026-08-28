import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    linkSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    applyPageMetadataRemap,
    remapPageMetadata,
} from '@electron/features/page-ops/main/pageMetadataRemap';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

const mocks = vi.hoisted(() => ({
    getPdfNativeToolPaths: vi.fn(() => ({qpdf: '/mock/qpdf'})),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/features/page-ops/main/nativePageOpsPath', () => ({
    isNativePageOpsDisabled: () => false,
    resolveNativePageOpsPath: () => '/mock/evb-pdf-page-ops',
}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => mocks.getPdfNativeToolPaths()}));

const bookmark = (title: string, pageIndex: number | null, items: IPdfBookmarkEntry[] = []): IPdfBookmarkEntry => ({
    title,
    pageIndex,
    namedDest: pageIndex === null ? 'named' : null,
    bold: false,
    italic: false,
    color: null,
    items,
});

let tempRoot = '';

describe('page metadata remap', () => {
    beforeEach(() => {
        tempRoot = mkdtempSync(join(tmpdir(), 'evb-page-metadata-remap-'));
        mocks.runNativeToolCommand.mockReset();
        mocks.runNativeToolCommand.mockResolvedValue({
            stdout: '',
            stderr: '',
            exitCode: 0,
        });
    });

    afterEach(() => {
        rmSync(tempRoot, {
            force: true,
            recursive: true,
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

    it('writes the remapped metadata as an incremental append', async () => {
        const workingCopyPath = join(tempRoot, 'working.pdf');
        writeFileSync(workingCopyPath, 'pdf');
        await applyPageMetadataRemap({
            workingCopyPath,
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
        expect(args[0]).toBe('save-mutations');
        expect(args).toContain('--append');
        expect(args).toEqual(expect.arrayContaining([
            '--qpdf',
            '/mock/qpdf',
        ]));
        expect(args.some(arg => arg.startsWith('--incremental-validation'))).toBe(false);
    });

    it('refuses an in-place append when the working-copy inode is shared', async () => {
        const originalPath = join(tempRoot, 'original.pdf');
        const workingCopyPath = join(tempRoot, 'working.pdf');
        writeFileSync(originalPath, 'pdf');
        linkSync(originalPath, workingCopyPath);

        await expect(applyPageMetadataRemap({
            workingCopyPath,
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
            cancelGroup: 'page-remap-shared-inode',
        })).rejects.toThrow('exclusively owned working-copy inode');
        expect(mocks.runNativeToolCommand).not.toHaveBeenCalled();
    });
});
