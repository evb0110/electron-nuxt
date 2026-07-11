import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { toPersistedDocumentRecord } from '@app/platform/browser/browserDocumentRecords';

function createRecord(overrides: Record<string, unknown> = {}) {
    return {
        ref: 'browser-document:1',
        fileName: 'document.pdf',
        mimeType: 'application/pdf',
        kind: 'working',
        data: new Uint8Array(),
        fileSize: 0,
        updatedAt: 1,
        saveKind: 'pdf',
        saveHandle: null,
        storageMode: 'inline',
        chunkCount: 0,
        chunkSize: 1,
        ...overrides,
    };
}

describe('toPersistedDocumentRecord', () => {
    it.each([
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1.5,
    ])('rejects invalid persisted file sizes (%s)', (fileSize) => {
        expect(toPersistedDocumentRecord(createRecord({fileSize}))).toBeNull();
    });

    it('drops serialized file-handle lookalikes without a callable getFile method', () => {
        const record = toPersistedDocumentRecord(createRecord({saveHandle: {
            kind: 'file',
            name: 'document.pdf',
        }}));

        expect(record).not.toBeNull();
        expect(record?.saveHandle).toBeUndefined();
    });

    it('retains file handles that expose a callable getFile method', () => {
        const getFile = vi.fn();
        const saveHandle = {
            kind: 'file',
            name: 'document.pdf',
            getFile,
        };
        const record = toPersistedDocumentRecord(createRecord({saveHandle}));

        expect(record?.saveHandle).toBe(saveHandle);
    });
});
