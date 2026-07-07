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
});
