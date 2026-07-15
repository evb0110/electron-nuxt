// @vitest-environment happy-dom

import {
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    onBeforeUnmount,
    ref,
} from 'vue';
import { flattenPdfVirtualPageSegments } from '@app/modules/pdf-viewer/runtime/composables/flattenPdfVirtualPageSegments';
import type { IPdfVirtualPageSegment } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';

describe('PdfViewerViewport virtual page identity', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('uses the same keyed restored-page frame from immediate shell through authoritative geometry', () => {
        const initialItems = flattenPdfVirtualPageSegments([], {
            initialPageShell: true,
            initialPageShellPage: 7,
        });
        const authoritativeItems = flattenPdfVirtualPageSegments([{
            start: 7,
            end: 7,
            key: '7:7',
            pages: [7],
            spacerBeforeStyle: null,
        }]);

        expect(initialItems).toEqual([{
            key: 'page:7',
            kind: 'page',
            page: 7,
        }]);
        expect(authoritativeItems[0]).toEqual(initialItems[0]);
    });

    it('retains overlapping page instances when virtual segment bounds collapse', async () => {
        const segments = ref<IPdfVirtualPageSegment[]>([{
            start: 1,
            end: 26,
            key: '1:26',
            pages: Array.from({length: 26}, (_, index) => index + 1),
            spacerBeforeStyle: null,
        }]);
        const unmountedPages: number[] = [];
        const PageDouble = defineComponent({
            props: {page: {
                type: Number,
                required: true,
            }},
            setup(props) {
                onBeforeUnmount(() => unmountedPages.push(props.page));
                return () => h('div', {'data-page-double': String(props.page)});
            },
        });
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            return () => flattenPdfVirtualPageSegments(segments.value).map(item => (
                item.kind === 'page'
                    ? h(PageDouble, {
                        key: item.key,
                        page: item.page,
                    })
                    : h('div', {
                        key: item.key,
                        style: item.style,
                    })
            ));
        }}));

        app.mount(host);
        await nextTick();
        const retainedPage = host.querySelector('[data-page-double="7"]');
        expect(retainedPage).not.toBeNull();

        segments.value = [{
            start: 5,
            end: 9,
            key: '5:9',
            pages: [
                5,
                6,
                7,
                8,
                9,
            ],
            spacerBeforeStyle: null,
        }];
        await nextTick();

        expect(host.querySelector('[data-page-double="7"]')).toBe(retainedPage);
        expect(unmountedPages).not.toContain(7);
        expect(unmountedPages).toContain(1);

        app.unmount();
    });

    it('keeps the leading spacer identity stable across distant virtual windows', () => {
        const first = flattenPdfVirtualPageSegments([{
            start: 20,
            end: 22,
            key: '20:22',
            pages: [
                20,
                21,
                22,
            ],
            spacerBeforeStyle: {height: '1900px'},
        }]);
        const distant = flattenPdfVirtualPageSegments([{
            start: 200,
            end: 202,
            key: '200:202',
            pages: [
                200,
                201,
                202,
            ],
            spacerBeforeStyle: {height: '19900px'},
        }]);

        expect(first[0]?.key).toBe('spacer:0');
        expect(distant[0]?.key).toBe(first[0]?.key);
    });
});
