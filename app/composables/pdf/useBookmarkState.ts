import type { IPdfBookmarkEntry } from '@app/types/pdf';

export const useBookmarkState = (deps: {
    markDirty: () => void;
    onBookmarksSynchronized?: () => void;
    onBookmarksDirty?: () => void;
    onBookmarksSaved?: () => void;
}) => {
    const {
        markDirty,
        onBookmarksSynchronized,
        onBookmarksDirty,
        onBookmarksSaved,
    } = deps;

    const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
    const bookmarksDirty = ref(false);
    const bookmarkEditMode = ref(false);

    function markBookmarksSaved() {
        bookmarksDirty.value = false;
        onBookmarksSaved?.();
    }

    function handleBookmarksChange(payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }) {
        bookmarkItems.value = payload.bookmarks;

        if (payload.dirty) {
            if (!bookmarksDirty.value) {
                markDirty();
            }
            bookmarksDirty.value = true;
            onBookmarksDirty?.();
            return;
        }

        bookmarksDirty.value = false;
        onBookmarksSynchronized?.();
    }

    return {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        handleBookmarksChange,
    };
};
