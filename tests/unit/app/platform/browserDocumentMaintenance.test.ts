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
    recoveryRecordsAtDelete: [] as Array<{snapshotRefs: string[]}>,
    runObjectStoresTransaction: vi.fn(async (
        _stores: string[],
        _mode: string,
        run: (transaction: unknown, setResult: (value: unknown) => void) => void,
    ) => {
        let result: unknown = null;
        const recoveryRequest = {result: documentIdbMocks.recoveryRecordsAtDelete} as {
            result: unknown;
            onsuccess?: () => void;
        };
        const transaction = {objectStore: (name: string) => ({
            getAll: () => recoveryRequest,
            delete: name.includes('chunk')
                ? chunkMocks.deleteChunkRecord
                : documentIdbMocks.deleteRecord,
        })};
        run(transaction, value => { result = value; });
        recoveryRequest.onsuccess?.();
        return result;
    }),
}));

const chunkMocks = vi.hoisted(() => ({
    deleteChunkRecord: vi.fn(async () => undefined),
    loadAllChunkKeys: vi.fn(async () => []),
    loadAllChunkKeysAvailability: vi.fn(async () => ({
        available: true,
        value: [] as IDBValidKey[] | null,
    })),
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
const recoveryMocks = vi.hoisted(() => ({loadBrowserWorkspaceRecoveryLeasedRefs: vi.fn(async () => new Set<string>())}));

vi.mock('@app/platform/browser/browserDocumentIdb', () => documentIdbMocks);
vi.mock('@app/platform/browser/browserDocumentChunks', () => chunkMocks);
vi.mock('@app/platform/browser/browserRecentFilesStore', () => recentFilesStoreMocks);
vi.mock('@app/platform/browser/browserWorkspaceRecoveryStore', () => recoveryMocks);

describe('browserDocumentMaintenance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: false,
            value: null,
        });
        chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
            available: true,
            value: [],
        });
        recoveryMocks.loadBrowserWorkspaceRecoveryLeasedRefs.mockResolvedValue(new Set());
        documentIdbMocks.recoveryRecordsAtDelete = [];
    });

    it('retains a working document while the recovery journal leases it', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/recovery.pdf';
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'recovery.pdf',
                mimeType: 'application/pdf',
                kind: 'working',
                retention: 'durable',
                data: Uint8Array.of(1),
                fileSize: 1,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        recoveryMocks.loadBrowserWorkspaceRecoveryLeasedRefs.mockResolvedValue(new Set([ref]));

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalledWith(ref);
    });

    it('rechecks a recovery lease committed while a destructive sweep is running', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/recovery-race.pdf';
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'recovery-race.pdf',
                mimeType: 'application/pdf',
                kind: 'working',
                retention: 'transient',
                data: Uint8Array.of(1),
                fileSize: 1,
                updatedAt: 1,
                storageMode: 'inline',
                chunkCount: 0,
                chunkSize: 4,
            },
        });
        recoveryMocks.loadBrowserWorkspaceRecoveryLeasedRefs.mockResolvedValue(new Set());
        documentIdbMocks.recoveryRecordsAtDelete = [{snapshotRefs: [ref]}];

        await sweepBrowserDocumentMaintenance(new Map());

        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalledWith(ref);
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

    it('skips destructive maintenance when chunk keys are unavailable', async () => {
        const { sweepBrowserDocumentMaintenance } = await import('@app/platform/browser/browserDocumentMaintenance');
        const ref = 'browser://documents/chunked.pdf';
        documentIdbMocks.loadAllRecordKeysAvailability.mockResolvedValue({
            available: true,
            value: [ref],
        });
        documentIdbMocks.loadRecordAvailability.mockResolvedValue({
            available: true,
            value: {
                ref,
                fileName: 'chunked.pdf',
                mimeType: 'application/pdf',
                kind: 'source',
                retention: 'durable',
                data: new Uint8Array(),
                fileSize: 8,
                updatedAt: 1,
                storageMode: 'chunked',
                chunkCount: 2,
                chunkSize: 4,
                chunkGeneration: 'generation',
            },
        });
        chunkMocks.loadAllChunkKeysAvailability.mockResolvedValue({
            available: false,
            value: null,
        });
        const entries = new Map([[
            ref,
            {
                ref,
                pendingLoad: null,
            },
        ]]);

        await expect(sweepBrowserDocumentMaintenance(entries as never)).resolves.toBeUndefined();

        expect(recentFilesStoreMocks.pruneRecentFiles).not.toHaveBeenCalled();
        expect(recentFilesStoreMocks.writeRecentFilesToStorage).not.toHaveBeenCalled();
        expect(documentIdbMocks.deleteRecord).not.toHaveBeenCalled();
        expect(chunkMocks.deleteChunkRecord).not.toHaveBeenCalled();
        expect(entries.has(ref)).toBe(true);
    });
});
