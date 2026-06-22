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
    let bookmarkRevision = 0;

    function markBookmarksSaved() {
        bookmarksDirty.value = false;
        onBookmarksSaved?.();
    }

    function handleBookmarksChange(payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }) {
        bookmarkItems.value = payload.bookmarks;
        bookmarkRevision += 1;

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

    function getBookmarksRevision() {
        return bookmarkRevision;
    }

    return {
        bookmarkItems,
        bookmarksDirty,
        bookmarkEditMode,
        markBookmarksSaved,
        getBookmarksRevision,
        handleBookmarksChange,
    };
};
