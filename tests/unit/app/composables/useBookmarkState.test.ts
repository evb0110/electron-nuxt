import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useBookmarkState } from '@app/composables/pdf/useBookmarkState';

describe('useBookmarkState', () => {
    it('records dirty bookmark updates through the callback hook', () => {
        const markDirty = vi.fn();
        const onBookmarksDirty = vi.fn();
        const state = useBookmarkState({
            markDirty,
            onBookmarksDirty,
        });

        state.handleBookmarksChange({
            bookmarks: [{
                title: 'Intro',
                pageIndex: 0,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
            dirty: true,
        });

        expect(state.bookmarksDirty.value).toBe(true);
        expect(markDirty).toHaveBeenCalledOnce();
        expect(onBookmarksDirty).toHaveBeenCalledOnce();
    });

    it('resets the bookmark baseline when synchronized or saved', () => {
        const onBookmarksSynchronized = vi.fn();
        const onBookmarksSaved = vi.fn();
        const state = useBookmarkState({
            markDirty: vi.fn(),
            onBookmarksSynchronized,
            onBookmarksSaved,
        });

        state.handleBookmarksChange({
            bookmarks: [],
            dirty: false,
        });
        state.markBookmarksSaved();

        expect(onBookmarksSynchronized).toHaveBeenCalledOnce();
        expect(onBookmarksSaved).toHaveBeenCalledOnce();
        expect(state.bookmarksDirty.value).toBe(false);
    });
});
