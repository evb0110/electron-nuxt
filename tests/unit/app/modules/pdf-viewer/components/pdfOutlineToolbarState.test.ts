// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    nextTick,
    reactive,
} from 'vue';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import PdfOutline from '@app/modules/pdf-viewer/components/PdfOutline.vue';
import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

function stub(marker: string) {
    return {default: defineComponent({
        inheritAttrs: false,
        setup: (_props, {attrs}) => () => h('div', {
            ...attrs,
            [marker]: '',
        }),
    })};
}

vi.mock('@app/components/AppSpinner.vue', () => stub('data-spinner-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkToolbar.vue', () => stub('data-bookmark-toolbar-stub'));
vi.mock('@app/components/document-viewer/DocumentBookmarkTree.vue', () => stub('data-bookmark-tree-stub'));
vi.mock('@app/components/document-viewer/DocumentPanelEmptyState.vue', () => stub('data-empty-state-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfOutlineContextMenu.vue', () => stub('data-context-menu-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfOutlineItem.vue', () => stub('data-outline-item-stub'));

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
});

function createPdfDocument(getOutline: () => Promise<unknown[] | null>) {
    return {
        _transport: {},
        getOutline,
    } as PDFDocumentProxy;
}

async function mountOutline(getOutline: () => Promise<unknown[] | null>) {
    const host = document.createElement('div');
    document.body.append(host);
    const viewProps = reactive({
        bookmarkItems: [] as IPdfBookmarkEntry[],
        bookmarksDirty: false,
        currentPage: 1,
        isEditMode: false,
        pdfDocument: createPdfDocument(getOutline),
    });
    const app = createApp(defineComponent({setup: () => () => h(PdfOutline, {...viewProps})}));
    app.component('UButton', defineComponent({setup: () => () => h('button')}));
    app.mount(host);
    await nextTick();

    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    async function settle() {
        await nextTick();
        await new Promise(resolve => setTimeout(resolve, 0));
        await nextTick();
    }

    return {
        applyExternalBookmarks(items: IPdfBookmarkEntry[]) {
            viewProps.bookmarkItems = items;
            viewProps.bookmarksDirty = true;
        },
        host,
        settle,
        unmount,
    };
}

function toolbar(host: HTMLElement) {
    return host.querySelector('[data-bookmark-toolbar-stub]');
}

describe('PdfOutline bookmark toolbar state', () => {
    it('defers the loading spinner while bookmarks are loading', async () => {
        const outline = await mountOutline(() => new Promise(() => undefined));

        expect(toolbar(outline.host)).toBeNull();
        expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
    });

    it('shows the loading spinner when bookmark loading outlasts the delay', async () => {
        vi.useFakeTimers();
        try {
            const outline = await mountOutline(() => new Promise(() => undefined));

            expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
            await vi.advanceTimersByTimeAsync(149);
            await nextTick();
            expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();

            await vi.advanceTimersByTimeAsync(1);
            await nextTick();

            expect(outline.host.querySelector('[data-spinner-stub]')).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides the toolbar and exposes an error state when loading fails', async () => {
        const outline = await mountOutline(() => Promise.reject(new Error('outline stream is corrupt')));

        await outline.settle();

        expect(toolbar(outline.host)).toBeNull();
        expect(outline.host.querySelector('[data-empty-state-stub]')?.getAttribute('title'))
            .toBe('bookmarks.unavailable');
    });

    it('shows the toolbar once an empty outline has loaded successfully', async () => {
        const outline = await mountOutline(() => Promise.resolve([]));

        expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
        await outline.settle();

        expect(toolbar(outline.host)).not.toBeNull();
        expect(outline.host.querySelector('[data-spinner-stub]')).toBeNull();
        expect(outline.host.querySelector('[data-empty-state-stub]')?.getAttribute('title'))
            .toBe('bookmarks.noBookmarks');
    });

    it('recovers from a load error when external bookmarks arrive', async () => {
        const outline = await mountOutline(() => Promise.reject(new Error('outline stream is corrupt')));

        await outline.settle();
        outline.applyExternalBookmarks([{
            title: 'Recovered bookmark',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
        await outline.settle();

        expect(toolbar(outline.host)).not.toBeNull();
        expect(outline.host.querySelector('[data-empty-state-stub]')).toBeNull();
    });
});
