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
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { SIDEBAR } from '@app/constants/pdfLayout';
import type { TPdfSidebarTab } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import PdfSidebar from '@app/modules/pdf-viewer/components/PdfSidebar.vue';

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => key})}));

const outlineLifecycle = {
    mounts: 0,
    unmounts: 0,
};

/**
 * Stands in for PdfOutline with the cheapest possible marker of panel-local
 * state: a value the sidebar never sees, so it can only survive a tab switch
 * if the panel itself is never torn down.
 */
vi.mock('@app/modules/pdf-viewer/components/PdfOutline.vue', async () => {
    const vue = await import('vue');
    const component = vue.defineComponent(() => {
        const panelState = vue.ref('');
        outlineLifecycle.mounts += 1;
        vue.onUnmounted(() => {
            outlineLifecycle.unmounts += 1;
        });
        return () => vue.h('div', {'data-outline-stub': ''}, [vue.h('input', {
            'data-outline-state': '',
            value: panelState.value,
            onInput: (event: Event) => {
                panelState.value = (event.target as HTMLInputElement).value;
            },
        })]);
    });
    return {default: component};
});

function stubPanel(marker: string) {
    const component = defineComponent({
        inheritAttrs: false,
        setup: (_props, {
            attrs,
            slots,
        }) => () => h('div', {
            ...attrs,
            [marker]: '',
        }, [
            slots.header?.(),
            slots.default?.(),
            slots.footer?.(),
        ]),
    });
    return {default: component};
}

vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationsPanel.vue', () => stubPanel('data-annotations-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfThumbnails.vue', () => stubPanel('data-thumbnails-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue', () => stubPanel('data-page-selection-stub'));
vi.mock('@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue', () => stubPanel('data-page-numbering-stub'));
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', () => stubPanel('data-search-stub'));
vi.mock('@app/components/document-viewer/DocumentSidebarPagesPanel.vue', () => stubPanel('data-pages-panel-stub'));

vi.mock('@app/components/sidebar/AppSidebarShell.vue', async () => {
    const vue = await import('vue');
    return {default: vue.defineComponent({
        props: {
            modelValue: {
                type: String,
                required: true,
            },
            tabs: {
                type: Array,
                required: true,
            },
            outerScroll: Boolean,
        },
        emits: ['update:model-value'],
        setup: (props, {
            emit,
            slots,
        }) => () => vue.h('aside', {'data-shell-stub': ''}, [
            (props.tabs as Array<{value: string}>).map(tab => vue.h('button', {
                key: tab.value,
                type: 'button',
                'data-tab': tab.value,
                onClick: () => emit('update:model-value', tab.value),
            })),
            slots.default?.(),
        ]),
    })};
});

const activeUnmounts = new Set<() => void>();

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    outlineLifecycle.mounts = 0;
    outlineLifecycle.unmounts = 0;
});

async function mountSidebar(overrides: {
    activeTab?: TPdfSidebarTab;
    isOpen?: boolean;
    width?: number;
} = {}) {
    const state = reactive({
        activeTab: overrides.activeTab ?? ('thumbnails' as TPdfSidebarTab),
        isOpen: overrides.isOpen ?? true,
    });
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(defineComponent({setup: () => () => h(PdfSidebar, {
        activeTab: state.activeTab,
        annotationComments: [],
        annotationCommentsStatus: 'ready',
        annotationKeepActive: false,
        annotationSettings: DEFAULT_ANNOTATION_SETTINGS,
        annotationTool: 'none',
        bookmarkEditMode: false,
        bookmarkItems: [],
        bookmarkNavigationIntentVersion: 0,
        bookmarksDirty: false,
        currentPage: 1,
        currentResultIndex: -1,
        currentResultNavigationId: 0,
        isOpen: state.isOpen,
        isSearching: false,
        pdfDocument: null,
        rasterScheduler: null,
        searchOptions: {
            matchCase: false,
            useRegex: false,
            wholeWord: false,
        },
        searchQuery: '',
        searchResults: [],
        selectedThumbnailPages: [],
        totalPages: 4,
        ...(overrides.width === undefined ? {} : {width: overrides.width}),
        'onUpdate:activeTab': (value: TPdfSidebarTab) => {
            state.activeTab = value;
        },
    })}));
    app.mount(host);
    await nextTick();
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    async function selectTab(tab: TPdfSidebarTab) {
        host.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.click();
        await nextTick();
        await nextTick();
    }

    return {
        host,
        selectTab,
        state,
        unmount,
    };
}

function outlinePanel(host: HTMLElement) {
    return host.querySelector<HTMLElement>('[data-outline-stub]');
}

describe('PdfSidebar bookmark panel retention', () => {
    it('does not mount the bookmark panel before its tab is first activated', async () => {
        const {host} = await mountSidebar();

        expect(outlinePanel(host)).toBeNull();
        expect(outlineLifecycle.mounts).toBe(0);
    });

    it('keeps panel-local bookmark state across tab switches', async () => {
        const {
            host,
            selectTab,
        } = await mountSidebar();

        await selectTab('bookmarks');
        expect(outlineLifecycle.mounts).toBe(1);
        const panelState = host.querySelector<HTMLInputElement>('[data-outline-state]')!;
        panelState.value = 'chapter three';
        panelState.dispatchEvent(new Event('input'));
        await nextTick();

        await selectTab('thumbnails');
        expect(outlineLifecycle.unmounts).toBe(0);
        expect(outlinePanel(host)?.style.display).toBe('none');

        await selectTab('bookmarks');
        expect(outlineLifecycle.mounts).toBe(1);
        expect(outlinePanel(host)?.style.display).not.toBe('none');
        expect(host.querySelector<HTMLInputElement>('[data-outline-state]')?.value).toBe('chapter three');
    });

    it('discards bookmark panel state when the sidebar host unmounts', async () => {
        const first = await mountSidebar();
        await first.selectTab('bookmarks');
        first.unmount();

        expect(outlineLifecycle.unmounts).toBe(1);

        const second = await mountSidebar();
        expect(outlinePanel(second.host)).toBeNull();
    });

    it('falls back to the shared default sidebar width', async () => {
        const {host} = await mountSidebar();
        const shell = host.querySelector<HTMLElement>('[data-shell-stub]')!;

        expect(shell.style.width).toBe(`${SIDEBAR.DEFAULT_WIDTH}px`);
    });
});
