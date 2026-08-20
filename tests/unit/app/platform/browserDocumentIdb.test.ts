import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    loadAllRecordKeys,
    loadAllRecordKeysAvailability,
    loadRecord,
    loadRecordAvailability,
} from '@app/platform/browser/browserDocumentIdb';
import {
    loadAllChunkKeys,
    loadAllChunkKeysAvailability,
} from '@app/platform/browser/browserDocumentChunks';
import { cast } from '@tests/helpers/cast';

describe('browserDocumentIdb', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('treats synchronous IndexedDB open failures as unavailable storage', async () => {
        vi.stubGlobal('indexedDB', { open: () => {
            throw new DOMException('blocked', 'SecurityError');
        }});

        await expect(loadRecord('browser://documents/example/file.pdf')).resolves.toBeNull();
        await expect(loadAllRecordKeys()).resolves.toBeNull();
        await expect(loadRecordAvailability('browser://documents/example/file.pdf')).resolves.toEqual({
            available: false,
            value: null,
        });
        await expect(loadAllRecordKeysAvailability()).resolves.toEqual({
            available: false,
            value: null,
        });
        await expect(loadAllChunkKeys()).resolves.toBeNull();
        await expect(loadAllChunkKeysAvailability()).resolves.toEqual({
            available: false,
            value: null,
        });
    });

    it('bounds blocked opens and closes a database connection that succeeds after timeout', async () => {
        vi.useFakeTimers();
        const close = vi.fn();
        const request: Partial<IDBOpenDBRequest> = {};
        vi.stubGlobal('indexedDB', {open: () => request});

        const pending = loadRecordAvailability('browser://documents/example/file.pdf');
        request.onblocked?.call(
            cast<IDBOpenDBRequest>(request),
            new Event('blocked') as IDBVersionChangeEvent,
        );
        await vi.advanceTimersByTimeAsync(4_000);

        await expect(pending).resolves.toEqual({
            available: false,
            value: null,
        });

        Object.defineProperty(request, 'result', {
            configurable: true,
            value: cast<IDBDatabase>({close}),
        });
        request.onsuccess?.call(
            cast<IDBOpenDBRequest>(request),
            new Event('success'),
        );
        expect(close).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });
});
