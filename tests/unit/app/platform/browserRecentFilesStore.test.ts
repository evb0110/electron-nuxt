import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { BrowserRecentFilesStore } from '@app/platform/browser/browserRecentFilesStore';

describe('BrowserRecentFilesStore', () => {
    beforeEach(() => {
        const storage = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: vi.fn((key: string) => storage.get(key) ?? null),
            removeItem: vi.fn((key: string) => {
                storage.delete(key);
            }),
            setItem: vi.fn((key: string, value: string) => {
                storage.set(key, value);
            }),
        });
    });

    it('does not rebuild recent-files storage when IndexedDB is unavailable', async () => {
        const repository = {
            requireEntry: vi.fn(),
            getAllPersistedRecords: vi.fn(async () => ({
                available: false,
                records: [],
            })),
            cleanupEvictedRecentRefs: vi.fn(async () => undefined),
        };
        const store = new BrowserRecentFilesStore(repository);

        await expect(store.recoverRecentFilesIfStorageMissing()).resolves.toEqual([]);

        expect(repository.getAllPersistedRecords).toHaveBeenCalledOnce();
        expect(globalThis.localStorage.setItem).not.toHaveBeenCalled();
    });
});
