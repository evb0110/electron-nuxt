import {
    describe,
    expect,
    it,
} from 'vitest';
import { getPdfPersistencePortMessageData } from '@electron/features/documents/main/serializedPdfPersistence';

describe('serialized PDF persistence', () => {
    it('accepts Electron MessageEvent-style port messages', () => {
        const message = {
            type: 'chunk',
            seq: 0,
            bytes: new Uint8Array([
                1,
                2,
            ]),
        };

        expect(getPdfPersistencePortMessageData({ data: message })).toBe(message);
    });

    it('accepts direct MessagePortMain payloads', () => {
        const message = { type: 'complete' };

        expect(getPdfPersistencePortMessageData(message)).toBe(message);
    });

    it('accepts direct payloads that have an undefined data field', () => {
        const message = {
            type: 'complete',
            data: undefined,
        };

        expect(getPdfPersistencePortMessageData(message)).toBe(message);
    });

    it('accepts direct payloads that have a null data field', () => {
        const message = {
            type: 'complete',
            data: null,
        };

        expect(getPdfPersistencePortMessageData(message)).toBe(message);
    });
});
