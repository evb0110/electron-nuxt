// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import EN_MESSAGES from '@i18n-app/messages/en';
import RU_MESSAGES from '@i18n-app/messages/ru';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import {
    ENRICHED_ENRICHMENT_STATE,
    ENRICHMENT_NOTICE_SELECTOR,
    ENRICHMENT_RETRY_SELECTOR,
    PENDING_ENRICHMENT_STATE,
    mountEnrichmentHost,
    resolveEnrichmentState,
    skippedEnrichment,
} from '@tests/helpers/annotationEnrichmentNoticeHarness';
import type { TEnrichmentStateSource } from '@tests/helpers/annotationEnrichmentNoticeHarness';
import PdfSidebar from '@app/modules/pdf-viewer/components/PdfSidebar.vue';

/**
 * The notice is only useful if it survives every hop from the viewer bridge to
 * the panel. This mounts the real annotations panel and the real comments list
 * inside the sidebar, so a dropped prop or an unforwarded event fails here
 * rather than silently reaching users as a document with no explanation.
 */

vi.mock('@app/composables/useSettings', () => ({useSettings: () => ({settings: {authorName: null}})}));
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationToolbar.vue', () => ({default: {render: () => null}}));
vi.mock('@app/modules/pdf-viewer/components/PdfAnnotationStyleEditor.vue', () => ({default: {render: () => null}}));
vi.mock('@app/modules/pdf-viewer/components/PdfOutline.vue', () => ({default: {render: () => null}}));
vi.mock('@app/modules/pdf-viewer/components/PdfThumbnails.vue', () => ({default: {render: () => null}}));
vi.mock('@app/modules/pdf-viewer/components/PdfPageSelectionBar.vue', () => ({default: {render: () => null}}));
vi.mock('@app/modules/pdf-viewer/components/PdfSidebarPageNumbering.vue', () => ({default: {render: () => null}}));
vi.mock('@app/components/document-viewer/DocumentSearchPanel.vue', () => ({default: {render: () => null}}));
vi.mock('@app/components/document-viewer/DocumentSidebarPagesPanel.vue', () => ({default: {render: () => null}}));
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
        setup: (_props, { slots }) => () => vue.h('aside', {'data-shell-stub': ''}, [slots.default?.()]),
    })};
});

let unmountSidebar: (() => void) | null = null;

afterEach(() => {
    unmountSidebar?.();
    unmountSidebar = null;
});

async function mountSidebar(options: {
    enrichmentState?: TEnrichmentStateSource;
    onRetry?: () => void;
} = {}) {
    const enrichmentState = options.enrichmentState ?? PENDING_ENRICHMENT_STATE;
    const {
        host,
        unmount,
    } = await mountEnrichmentHost(PdfSidebar, () => ({
        'activeTab': 'annotations',
        'annotationComments': [],
        'annotationCommentsStatus': 'ready',
        'annotationEnrichmentState': resolveEnrichmentState(enrichmentState),
        'annotationKeepActive': false,
        'annotationSettings': DEFAULT_ANNOTATION_SETTINGS,
        'annotationTool': 'none',
        'bookmarkEditMode': false,
        'bookmarkItems': [],
        'bookmarkNavigationIntentVersion': 0,
        'bookmarksDirty': false,
        'currentPage': 1,
        'currentResultIndex': -1,
        'currentResultNavigationId': 0,
        'isOpen': true,
        'isSearching': false,
        'pdfDocument': null,
        'rasterScheduler': null,
        'searchOptions': {
            matchCase: false,
            useRegex: false,
            wholeWord: false,
        },
        'searchQuery': '',
        'searchResults': [],
        'selectedThumbnailPages': [],
        'totalPages': 4,
        'onAnnotationRetryEnrichment': options.onRetry ?? (() => {}),
    }));
    unmountSidebar = unmount;
    return host;
}

describe('PdfSidebar annotation enrichment wiring', () => {
    it('shows the skip notice inside the annotations panel', async () => {
        const host = await mountSidebar({enrichmentState: skippedEnrichment('over-byte-limit', false)});

        const notice = host.querySelector(ENRICHMENT_NOTICE_SELECTOR);

        expect(notice).not.toBeNull();
        expect(notice?.textContent).toContain('annotations.enrichmentSkippedSize');
    });

    it.each([
        {
            label: 'pending',
            enrichmentState: PENDING_ENRICHMENT_STATE,
        },
        {
            label: 'enriched',
            enrichmentState: ENRICHED_ENRICHMENT_STATE,
        },
    ])('shows nothing new for a $label document', async ({ enrichmentState }) => {
        const host = await mountSidebar({ enrichmentState });

        expect(host.querySelector(ENRICHMENT_NOTICE_SELECTOR)).toBeNull();
    });

    it('forwards the notice retry all the way up to the sidebar host', async () => {
        const onRetry = vi.fn();
        const host = await mountSidebar({
            enrichmentState: skippedEnrichment('over-page-count', true),
            onRetry,
        });

        host.querySelector<HTMLButtonElement>(ENRICHMENT_RETRY_SELECTOR)?.click();
        await nextTick();

        expect(onRetry).toHaveBeenCalledOnce();
    });

    it.each([
        'enrichmentSkippedSize',
        'enrichmentSkippedSource',
        'enrichmentFailed',
        'enrichmentRetry',
    ] as const)('translates %s in both required locales', (key) => {
        const english = EN_MESSAGES.annotations[key];
        const russian = RU_MESSAGES.annotations[key];

        expect(english.trim().length).toBeGreaterThan(0);
        expect(russian.trim().length).toBeGreaterThan(0);
        // A copied English string is an untranslated placeholder, not a translation.
        expect(russian).not.toBe(english);
        expect(russian).toMatch(/\p{Script=Cyrillic}/u);
    });
});
