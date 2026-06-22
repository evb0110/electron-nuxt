import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    loadAllRecordKeys,
    loadRecord,
} from '@app/platform/browser/browserDocumentIdb';

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
    });
});
