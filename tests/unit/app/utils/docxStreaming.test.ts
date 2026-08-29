import {
    describe,
    expect,
    it,
} from 'vitest';
import {createDocxFromTextAsync} from '@app/utils/docx';
import {createDocxFromTextChunks} from '@app/utils/docxStreaming';

describe('createDocxFromTextAsync', () => {
    it('builds a DOCX package while checking the caller signal', async () => {
        const controller = new AbortController();
        const output = await createDocxFromTextAsync('catalog text', false, controller.signal);

        expect(output.byteLength).toBeGreaterThan(0);
        expect(new TextDecoder().decode(output.slice(0, 2))).toBe('PK');
    });

    it('rejects before building when its signal is already canceled', async () => {
        const controller = new AbortController();
        controller.abort(new DOMException('DOCX export was canceled.', 'AbortError'));

        await expect(createDocxFromTextAsync('catalog text', false, controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });
});

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
