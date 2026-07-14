import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DOCUMENT_SIDEBAR_TAB_ORDER,
    reconcileDocumentSidebarTab,
    resolveDocumentSidebarTabs,
} from '@app/utils/document-viewer/sidebar/documentSidebarTabs';
import {useDocumentSidebarCapabilitySession} from '@app/utils/document-viewer/sidebar/useDocumentSidebarCapabilitySession';
import {
    computed,
    ref,
} from 'vue';

describe('document sidebar tabs', () => {
    it('keeps one canonical format-independent order', () => {
        expect(DOCUMENT_SIDEBAR_TAB_ORDER).toEqual([
            'annotations',
            'thumbnails',
            'bookmarks',
            'search',
        ]);
        expect(resolveDocumentSidebarTabs({
            annotations: true,
            bookmarks: true,
            pages: true,
            search: true,
        })).toEqual(DOCUMENT_SIDEBAR_TAB_ORDER);
    });

    it('filters only unavailable domain augmentations without reordering tabs', () => {
        const available = resolveDocumentSidebarTabs({
            annotations: false,
            bookmarks: true,
            pages: true,
            search: true,
        });
        expect(available).toEqual([
            'thumbnails',
            'bookmarks',
            'search',
        ]);
        expect(reconcileDocumentSidebarTab('annotations', available)).toBe('thumbnails');
    });

    it('preserves a preferred PDF augmentation while DjVu exposes a common effective tab', () => {
        const preferredTab = ref<'annotations' | 'thumbnails' | 'bookmarks' | 'search'>('annotations');
        const ready = ref(false);
        const supportsAnnotations = ref(false);
        const session = useDocumentSidebarCapabilitySession({
            capabilities: computed(() => ({
                annotations: supportsAnnotations.value,
                bookmarks: true,
                pages: true,
                search: true,
            })),
            capabilitiesReady: computed(() => ready.value),
            preferredTab,
        });

        expect(session.effectiveTab.value).toBe('annotations');
        ready.value = true;
        expect(session.effectiveTab.value).toBe('thumbnails');
        expect(preferredTab.value).toBe('annotations');
        supportsAnnotations.value = true;
        expect(session.effectiveTab.value).toBe('annotations');
    });
});
