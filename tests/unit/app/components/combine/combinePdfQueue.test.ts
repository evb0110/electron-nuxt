import {
    describe,
    expect,
    it,
} from 'vitest';
import {mergeCombinePdfQueue} from '@app/modules/combine/mergeCombinePdfQueue';

describe('mergeCombinePdfQueue', () => {
    it('preserves order, reports unsupported files, and allows intentional duplicates', () => {
        const duplicate = new File(['pdf'], 'same.pdf', {type: 'application/pdf'});
        const unsupported = new File(['text'], 'notes.txt', {type: 'text/plain'});
        const result = mergeCombinePdfQueue<File>([duplicate], [
            duplicate,
            unsupported,
        ], {
            isSupported: file => file.name.endsWith('.pdf'),
            toQueueItem: file => file,
        });

        expect(result.files).toEqual([
            duplicate,
            duplicate,
        ]);
        expect(result.rejected).toBe(1);
    });
});
