import type {
    ComputedRef,
    Ref,
} from 'vue';
import type {
    IBookmarkDropTarget,
    TBookmarkDisplayMode,
} from '@app/types/pdfOutline';

export interface IPdfOutlineTreeContext {
    expandedBookmarkIds: Ref<Set<string>>;
    activeItemId: Ref<string | null>;
    editingItemId: Ref<string | null>;
    selectedBookmarkIds: Ref<Set<string>>;
    displayMode: Ref<TBookmarkDisplayMode>;
    isEditMode: ComputedRef<boolean>;
    draggingItemIds: Ref<Set<string>>;
    dropTarget: Ref<IBookmarkDropTarget | null>;
    styleRangeStartId: Ref<string | null>;
    activePathBookmarkIds: ComputedRef<Set<string>>;
    beginBookmarkNavigationRequest: () => number;
    isBookmarkNavigationRequestCurrent: (requestId: number) => boolean;
}
