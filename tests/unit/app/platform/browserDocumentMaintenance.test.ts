import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const documentIdbMocks = vi.hoisted(() => ({
    deleteRecord: vi.fn(async () => undefined),
    loadAllRecordKeysAvailability: vi.fn(),
    loadRecordAvailability: vi.fn(),
}));

const chunkMocks = vi.hoisted(() => ({
    deleteChunkRecord: vi.fn(async () => undefined),
    loadAllChunkKeys: vi.fn(async () => []),
    parseChunkKey: vi.fn(),
}));

const recentFilesStoreMocks = vi.hoisted(() => ({
    hasRecentFilesStorageSnapshot: vi.fn(() => false),
    pruneRecentFiles: vi.fn((recentFiles: unknown[]) => ({
        recentFiles,
        evictedRefs: [],
    })),
    readRecentFilesFromStorage: vi.fn(() => []),
    writeRecentFilesToStorage: vi.fn(),
}));

vi.mock('@app/platform/browser/browserDocumentIdb', () => documentIdbMocks);
vi.mock('@app/platform/browser/browserDocumentChunks', () => chunkMocks);
vi.mock('@app/platform/browser/browserRecentFilesStore', () => recentFilesStoreMocks);

describe('browserDocumentMaintenance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: false,
            value: null,
        });
    });

    it('skips maintenance pruning when persisted IndexedDB records are unavailable', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const entries = new Map([[
            'browser://documents/source.pdf',
            {
                ref: 'browser://documents/source.pdf',
                pendingLoad: null,
            },
        ]]);

        await expect(sweepBrowserDocumentMaintenance(entries as never)).resolves.toBeUndefined();

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalled();
        expect(chunkMocks.deleteChunkRecord).not.toHaveBeenCalled();
        expect(recentFilesStoreMocks.writeRecentFilesToStorage).not.toHaveBeenCalled();
        expect(entries.has('browser://documents/source.pdf')).toBe(true);
    });
});
