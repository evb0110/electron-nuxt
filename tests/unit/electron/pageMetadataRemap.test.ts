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
import {readFile} from 'node:fs/promises';
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

        const pageLabels = result.pageLabels;
        const bookmarks = result.bookmarks;
        expect(pageLabels).toBeDefined();
        expect(bookmarks).toBeDefined();
        if (!pageLabels || !bookmarks) throw new Error('known metadata was not remapped');
        expect(pageLabels.ranges.map(range => range.prefix)).toEqual([
            '2',
            '2',
            'i',
            '1',
        ]);
        expect(bookmarks.items).toEqual([
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

    it('does not turn unknown metadata into deletion mutations', () => {
        const result = remapPageMetadata({untitledBookmarkLabel: 'Untitled'}, {
            previousPageCount: 2,
            pages: [
                {fromPageNumber: 2},
                {fromPageNumber: 1},
            ],
        });

        expect(result.pageLabels).toBeUndefined();
        expect(result.bookmarks).toBeUndefined();
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

    it('splits a 10,001-item outline across bounded native continuation appends', async () => {
        const workingCopyPath = join(tempRoot, 'working-large.pdf');
        writeFileSync(workingCopyPath, 'pdf');
        const payloads: Array<Record<string, unknown>> = [];
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            const mutationsFlagIndex = args.indexOf('--mutations-file');
            const payloadPath = args[mutationsFlagIndex + 1];
            payloads.push(JSON.parse(await readFile(payloadPath!, 'utf8')) as Record<string, unknown>);
            return {
                stdout: '',
                stderr: '',
                exitCode: 0,
            };
        });

        await applyPageMetadataRemap({
            workingCopyPath,
            delta: {
                previousPageCount: 10_001,
                nextPageCount: 10_001,
                ranges: [
                    {
                        kind: 'move',
                        fromPageNumber: 2,
                        toPageNumber: 1,
                        count: 10_000,
                    },
                    {
                        kind: 'move',
                        fromPageNumber: 1,
                        toPageNumber: 10_001,
                        count: 1,
                    },
                ],
            },
            metadataSnapshot: {
                pageLabels: null,
                bookmarks: Array.from({length: 10_001}, (_, index) => bookmark(`Page ${index + 1}`, index)),
                untitledBookmarkLabel: 'Untitled',
            },
            signal: new AbortController().signal,
            cancelGroup: 'page-remap-large-outline',
        });

        expect(payloads).toHaveLength(3);
        expect(payloads.map(payload => (payload.bookmarks as {items: unknown[]}).items.length))
            .toEqual([
                5_000,
                5_000,
                1,
            ]);
        expect(payloads[0]!.continuation).toBeUndefined();
        expect(payloads[1]!.continuation).toEqual({
            family: 'bookmarks',
            chunkIndex: 1,
            chunkCount: 3,
        });
        expect(payloads[2]!.continuation).toEqual({
            family: 'bookmarks',
            chunkIndex: 2,
            chunkCount: 3,
        });
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
