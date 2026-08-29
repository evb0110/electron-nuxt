import {
    describe,
    expect,
    it,
} from 'vitest';
import {createDocxFromTextChunks} from '@app/utils/docxStreaming';

describe('createDocxFromTextChunks', () => {
    it('rejects before producing output when its signal is already canceled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        const stream = createDocxFromTextChunks(['text'], false, controller.signal);

        await expect(stream.next()).rejects.toMatchObject({name: 'AbortError'});
    });

    it('stops between bounded output chunks when its signal is canceled', async () => {
        const controller = new AbortController();
        const stream = createDocxFromTextChunks(['text'], false, controller.signal);

        await expect(stream.next()).resolves.toMatchObject({done: false});
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(stream.next()).rejects.toMatchObject({name: 'AbortError'});
    });
});
