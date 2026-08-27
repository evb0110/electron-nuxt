import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfAnnotationIndexAdapter,
    createPdfAnnotationIndexLifecycle,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/createPdfAnnotationIndexAdapter';
import {PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} from '@contracts/electronApiDocuments';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const EXPECTED_REVISION = requireDocumentRevisionToken('drt1:expected');

const mocks = vi.hoisted(() => ({files: {
    beginPdfAnnotationIndex: vi.fn(),
    readPdfAnnotationIndexChunk: vi.fn(),
    releasePdfAnnotationIndex: vi.fn(),
    cancelPdfAnnotationIndex: vi.fn(),
    getDocumentRevision: vi.fn(),
}}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => mocks.files}));

function entry(
    pageIndex: number,
    objectNumber: number,
    name: string | null,
    subtype = 'Text',
) {
    return {
        pageIndex,
        objectNumber,
        generationNumber: 0,
        subtype,
        name,
        popupRef: null,
        parentRef: null,
    };
}

describe('createPdfAnnotationIndexAdapter', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        mocks.files.beginPdfAnnotationIndex.mockResolvedValue({
            sessionId: 'annotation-index-session',
            documentRef: '/tmp/document.pdf',
            documentRevisionToken: requireDocumentRevisionToken('drt1:test'),
            pageCount: 4,
            entryCount: 2,
            totalBytes: 256,
        });
        mocks.files.getDocumentRevision.mockResolvedValue({token: requireDocumentRevisionToken('drt1:fallback')});
        mocks.files.releasePdfAnnotationIndex.mockResolvedValue(true);
        mocks.files.cancelPdfAnnotationIndex.mockResolvedValue({canceled: true});
    });

    it('pulls bounded decoded chunks and retains earlier pages until they are consumed', async () => {
        mocks.files.readPdfAnnotationIndexChunk
            .mockResolvedValueOnce({
                offset: 0,
                nextOffset: 128,
                byteLength: 128,
                done: false,
                entries: [entry(0, 11, 'first-page-name')],
            })
            .mockResolvedValueOnce({
                offset: 128,
                nextOffset: null,
                byteLength: 128,
                done: true,
                entries: [entry(2, 33, 'third-page-name')],
            });

        const adapter = createPdfAnnotationIndexAdapter('/tmp/document.pdf');
        expect(adapter).not.toBeNull();
        const reader = await adapter!.begin(EXPECTED_REVISION);

        await expect(reader.readPage(2)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map([[
                '33R',
                'third-page-name',
            ]]),
        });
        await expect(reader.readPage(0)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map([[
                '11R',
                'first-page-name',
            ]]),
        });
        await expect(reader.readPage(1)).resolves.toEqual({
            hasAnnotations: false,
            names: new Map(),
        });

        expect(mocks.files.beginPdfAnnotationIndex).toHaveBeenCalledWith(
            '/tmp/document.pdf',
            {expectedDocumentRevisionToken: EXPECTED_REVISION},
        );
        expect(mocks.files.readPdfAnnotationIndexChunk).toHaveBeenNthCalledWith(
            1,
            'annotation-index-session',
            0,
            {chunkBytes: PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES},
        );
        await reader.release();
        expect(mocks.files.releasePdfAnnotationIndex).toHaveBeenCalledWith('annotation-index-session');
        expect(mocks.files.cancelPdfAnnotationIndex).not.toHaveBeenCalled();
    });

    it('reports presence for unnamed and direct entries without inventing names', async () => {
        mocks.files.readPdfAnnotationIndexChunk.mockResolvedValueOnce({
            offset: 0,
            nextOffset: null,
            byteLength: 256,
            done: true,
            entries: [
                entry(0, 0, null, 'Link'),
                entry(1, 21, null),
                entry(2, 22, 'named-entry'),
            ],
        });

        const adapter = createPdfAnnotationIndexAdapter('/tmp/document.pdf');
        const reader = await adapter!.begin(EXPECTED_REVISION);

        await expect(reader.readPage(0)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map(),
        });
        await expect(reader.readPage(1)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map(),
        });
        await expect(reader.readPage(2)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map([[
                '22R',
                'named-entry',
            ]]),
        });
        await expect(reader.readPage(3)).resolves.toEqual({
            hasAnnotations: false,
            names: new Map(),
        });
    });

    it('collects every entry when one page spans multiple chunks', async () => {
        mocks.files.readPdfAnnotationIndexChunk
            .mockResolvedValueOnce({
                offset: 0,
                nextOffset: 128,
                byteLength: 128,
                done: false,
                entries: [entry(0, 51, 'first-name')],
            })
            .mockResolvedValueOnce({
                offset: 128,
                nextOffset: null,
                byteLength: 128,
                done: true,
                entries: [
                    entry(0, 52, 'second-name'),
                    entry(1, 61, 'next-page-name'),
                ],
            });

        const adapter = createPdfAnnotationIndexAdapter('/tmp/document.pdf');
        const reader = await adapter!.begin(EXPECTED_REVISION);

        await expect(reader.readPage(0)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map([
                [
                    '51R',
                    'first-name',
                ],
                [
                    '52R',
                    'second-name',
                ],
            ]),
        });
        await expect(reader.readPage(1)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map([[
                '61R',
                'next-page-name',
            ]]),
        });
    });

    it('reads the final entry in a 150,000-page index without dense page allocation', async () => {
        mocks.files.beginPdfAnnotationIndex.mockResolvedValueOnce({
            sessionId: 'large-annotation-index-session',
            documentRef: '/tmp/large-document.pdf',
            documentRevisionToken: requireDocumentRevisionToken('drt1:test'),
            pageCount: 150_000,
            entryCount: 1,
            totalBytes: 128,
        });
        mocks.files.readPdfAnnotationIndexChunk.mockResolvedValueOnce({
            offset: 0,
            nextOffset: null,
            byteLength: 128,
            done: true,
            entries: [entry(149_999, 99, 'last-page-name')],
        });

        const adapter = createPdfAnnotationIndexAdapter('/tmp/large-document.pdf');
        const reader = await adapter!.begin(EXPECTED_REVISION);

        await expect(reader.readPage(149_999)).resolves.toEqual({
            hasAnnotations: true,
            names: new Map([[
                '99R',
                'last-page-name',
            ]]),
        });
        expect(mocks.files.readPdfAnnotationIndexChunk).toHaveBeenCalledOnce();
        expect(mocks.files.readPdfAnnotationIndexChunk).toHaveBeenCalledWith(
            'large-annotation-index-session',
            0,
            {chunkBytes: PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES},
        );
    });

    it('keeps the name-only compatibility read', async () => {
        mocks.files.readPdfAnnotationIndexChunk.mockResolvedValueOnce({
            offset: 0,
            nextOffset: null,
            byteLength: 128,
            done: true,
            entries: [entry(0, 44, 'legacy-name')],
        });

        const adapter = createPdfAnnotationIndexAdapter('/tmp/document.pdf');
        const reader = await adapter!.begin(EXPECTED_REVISION);

        await expect(reader.readPageNames(0)).resolves.toEqual(new Map([[
            '44R',
            'legacy-name',
        ]]));
    });

    it('releases a session even when cancellation reports an error', async () => {
        mocks.files.cancelPdfAnnotationIndex.mockRejectedValueOnce(new Error('already canceled'));
        const adapter = createPdfAnnotationIndexAdapter('/tmp/document.pdf');
        const reader = await adapter!.begin(null);

        await expect(reader.cancel()).rejects.toThrow('already canceled');
        await reader.release();

        expect(mocks.files.getDocumentRevision).toHaveBeenCalledWith('/tmp/document.pdf');
        expect(mocks.files.releasePdfAnnotationIndex).toHaveBeenCalledWith('annotation-index-session');
    });

    it('cancels and releases every reader in the lifecycle', async () => {
        const lifecycle = createPdfAnnotationIndexLifecycle();
        const reader = {
            readPage: vi.fn(async () => ({
                hasAnnotations: false,
                names: new Map<string, string>(),
            })),
            readPageNames: vi.fn(async () => new Map<string, string>()),
            cancel: vi.fn(async () => {}),
            release: vi.fn(async () => {}),
        };

        lifecycle.add(reader);
        lifecycle.cancelAll();
        await vi.waitFor(() => {
            expect(reader.cancel).toHaveBeenCalledOnce();
            expect(reader.release).toHaveBeenCalledOnce();
        });
    });
});
