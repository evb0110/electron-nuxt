import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { useDocumentTransitions } from '@app/modules/workspace-shell/composables/useDocumentTransitions';
import type { TPdfSource } from '@app/types/pdf';

function createDeps() {
    return {
        pdfSrc: ref<TPdfSource | null>({} as TPdfSource),
        workingCopyPath: ref('/tmp/test.pdf'),
        pdfError: ref<unknown>(null),
        currentPage: ref(7),
        totalPages: ref(23),
        pdfDocument: shallowRef<unknown | null>({ id: 'doc' }),
        dragMode: ref(false),
        showSidebar: ref(false),
        sidebarTab: ref<'annotations' | 'thumbnails' | 'bookmarks' | 'search'>('thumbnails'),
        annotationTool: ref<'none'>('none'),
        annotationComments: ref([]),
        annotationActiveCommentStableKey: ref<string | null>('note-1'),
        annotationEditorState: ref({
            isEditing: true,
            isEmpty: false,
            hasSomethingToUndo: true,
            hasSomethingToRedo: true,
            hasSelectedEditor: true,
        }),
        annotationPlacingPageNote: ref(true),
        bookmarkItems: ref([{}]),
        bookmarksDirty: ref(true),
        bookmarkEditMode: ref(true),
        pageLabels: ref<string[] | null>(['1']),
        pageLabelRanges: ref([{}]),
        pageLabelsDirty: ref(true),
        pdfViewerRef: ref({
            clearShapes: vi.fn(),
            cancelCommentPlacement: vi.fn(),
        }),
        resetAnnotationTracking: vi.fn(),
        resetSearchCache: vi.fn(),
        closeSearch: vi.fn(),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        closeAllAnnotationNotes: vi.fn(async () => true),
        loadRecentFiles: vi.fn(),
    };
}

describe('useDocumentTransitions', () => {
    it('clears viewer page state when the document unloads', async () => {
        const deps = createDeps();

        useDocumentTransitions(deps);

        deps.pdfSrc.value = null;
        await nextTick();

        expect(deps.currentPage.value).toBe(1);
        expect(deps.totalPages.value).toBe(0);
        expect(deps.pdfDocument.value).toBeNull();
    });

    it('refreshes recent files when the open document changes without unloading first', async () => {
        const deps = createDeps();

        useDocumentTransitions(deps);

        deps.workingCopyPath.value = '/tmp/next.pdf';
        deps.pdfSrc.value = {} as TPdfSource;
        await nextTick();

        expect(deps.loadRecentFiles).toHaveBeenCalledOnce();
    });
});
