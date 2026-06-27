import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useBookmarkState } from '@app/modules/pdf-viewer/runtime/composables/pdf/useBookmarkState';

describe('useBookmarkState', () => {
    it('records dirty bookmark updates through the source-specific callback hook', () => {
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
        expect(markDirty).not.toHaveBeenCalled();
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

    it('records a clean bookmark edit without treating it as document synchronization', () => {
        const markDirty = vi.fn();
        const onBookmarksDirty = vi.fn();
        const onBookmarksSynchronized = vi.fn();
        const state = useBookmarkState({
            markDirty,
            onBookmarksDirty,
            onBookmarksSynchronized,
        });

        state.handleBookmarksChange({
            bookmarks: [],
            dirty: false,
            history: 'record',
        });

        expect(state.bookmarksDirty.value).toBe(false);
        expect(markDirty).not.toHaveBeenCalled();
        expect(onBookmarksDirty).toHaveBeenCalledOnce();
        expect(onBookmarksSynchronized).not.toHaveBeenCalled();
    });
});
