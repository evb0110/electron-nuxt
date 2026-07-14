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
});
