import type {
    IPdfBookmarkChangePayload,
    IPdfBookmarkEntry,
} from '@app/types/pdf';

export const useBookmarkState = (deps: {
    markDirty: () => void;
    onBookmarksSynchronized?: () => void;
    onBookmarksDirty?: () => void;
    onBookmarksSaved?: () => void;
}) => {
    const {
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

    function handleBookmarksChange(payload: IPdfBookmarkChangePayload) {
        bookmarkItems.value = payload.bookmarks;
        bookmarkRevision += 1;
        const historyMode = payload.history ?? (payload.dirty ? 'record' : 'reset');

        if (historyMode === 'record') {
            bookmarksDirty.value = payload.dirty;
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
