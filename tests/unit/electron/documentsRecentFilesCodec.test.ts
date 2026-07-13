import {
    describe,
    expect,
    it,
} from 'vitest';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { DOCUMENTS_IPC_CODECS } from '@electron/features/documents/documentsIpcCodecs';

describe('documents Recent-files codec', () => {
    const decode = DOCUMENTS_IPC_CODECS[DOCUMENTS_CHANNELS.recentFilesGet].decodeResult;

    it('preserves an optional modified-time revision token', () => {
        expect(decode([{
            originalPath: '/tmp/a.pdf',
            fileName: 'a.pdf',
            timestamp: 1,
            fileSize: 20,
            modifiedAt: 30,
        }])).toEqual([{
            originalPath: '/tmp/a.pdf',
            fileName: 'a.pdf',
            timestamp: 1,
            fileSize: 20,
            modifiedAt: 30,
        }]);
    });

    it('accepts legacy entries and rejects malformed revision tokens', () => {
        expect(decode([{
            originalPath: '/tmp/legacy.pdf',
            fileName: 'legacy.pdf',
            timestamp: 1,
            fileSize: 20,
        }])).toHaveLength(1);
        expect(() => decode([{
            originalPath: '/tmp/a.pdf',
            fileName: 'a.pdf',
            timestamp: 1,
            fileSize: 20,
            modifiedAt: -1,
        }])).toThrow('invalid recent file');
    });
});
