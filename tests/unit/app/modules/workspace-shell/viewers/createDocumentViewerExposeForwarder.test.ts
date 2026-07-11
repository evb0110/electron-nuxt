import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shallowRef } from 'vue';
import { createDocumentViewerExposeForwarder } from '@app/modules/workspace-shell/viewers/createDocumentViewerExposeForwarder';

describe('createDocumentViewerExposeForwarder', () => {
    it('keeps one exposed port while the chassis swaps source feature packs', () => {
        const pdfScroll = vi.fn();
        const djvuScroll = vi.fn();
        const target = shallowRef<Record<PropertyKey, unknown> | null>({scrollToPage: pdfScroll});
        const exposed = createDocumentViewerExposeForwarder(target);
        const scrollToPage = (page: number) => {
            const method = Reflect.get(exposed, 'scrollToPage');
            if (typeof method !== 'function') {
                throw new Error('scrollToPage is unavailable');
            }
            method(page);
        };

        scrollToPage(3);
        target.value = {scrollToPage: djvuScroll};
        scrollToPage(7);

        expect(pdfScroll).toHaveBeenCalledWith(3);
        expect(djvuScroll).toHaveBeenCalledWith(7);
    });
});
