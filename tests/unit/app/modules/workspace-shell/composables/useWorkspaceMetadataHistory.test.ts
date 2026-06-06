import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { useWorkspaceMetadataHistory } from '@app/modules/workspace-shell/composables/useWorkspaceMetadataHistory';
import { maxWorkspaceMetadataHistoryEntries } from '@app/modules/workspace-shell/metadata/maxWorkspaceMetadataHistoryEntries';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';

function createHistory() {
    const bookmarkItems = ref<IPdfBookmarkEntry[]>([]);
    const bookmarksDirty = ref(false);
    const pageLabels = ref<string[] | null>(null);
    const pageLabelRanges = ref<IPdfPageLabelRange[]>([{
        startPage: 1,
        style: 'D',
        prefix: '',
        startNumber: 1,
    }]);
    const pageLabelsDirty = ref(false);
    const totalPages = ref(1);

    return {
        bookmarkItems,
        bookmarksDirty,
        pageLabels,
        pageLabelRanges,
        pageLabelsDirty,
        totalPages,
        history: useWorkspaceMetadataHistory({
            bookmarkItems,
            bookmarksDirty,
            pageLabels,
            pageLabelRanges,
            pageLabelsDirty,
            totalPages,
        }),
    };
}

describe('useWorkspaceMetadataHistory', () => {
    it('tracks bookmark and page label snapshots with undo/redo', () => {
        const {
            bookmarkItems,
            pageLabels,
            pageLabelRanges,
            bookmarksDirty,
            pageLabelsDirty,
            history,
        } = createHistory();

        history.resetToCurrentState();

        bookmarkItems.value = [{
            title: 'Chapter 1',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }];
        history.recordCurrentState();

        pageLabels.value = ['i'];
        pageLabelRanges.value = [{
            startPage: 1,
            style: 'r',
            prefix: '',
            startNumber: 1,
        }];
        history.recordCurrentState();

        expect(history.canUndoMetadata.value).toBe(true);
        expect(bookmarksDirty.value).toBe(true);
        expect(pageLabelsDirty.value).toBe(true);

        expect(history.undoMetadata()).toBe(true);
        expect(pageLabelRanges.value).toEqual([{
            startPage: 1,
            style: 'D',
            prefix: '',
            startNumber: 1,
        }]);
        expect(pageLabels.value).toBeNull();
        expect(bookmarkItems.value).toEqual([{
            title: 'Chapter 1',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
        expect(bookmarksDirty.value).toBe(true);
        expect(pageLabelsDirty.value).toBe(false);

        expect(history.undoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([]);
        expect(bookmarksDirty.value).toBe(false);

        expect(history.redoMetadata()).toBe(true);
        expect(bookmarkItems.value).toEqual([{
            title: 'Chapter 1',
            pageIndex: 0,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: [],
        }]);
    });

    it('caps metadata history while preserving the baseline snapshot', () => {
        const {
            bookmarkItems,
            bookmarksDirty,
            history,
        } = createHistory();

        history.resetToCurrentState();

        for (let index = 0; index < maxWorkspaceMetadataHistoryEntries + 10; index += 1) {
            bookmarkItems.value = [{
                title: `Bookmark ${index + 1}`,
                pageIndex: index,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }];
            history.recordCurrentState();
        }

        let undoCount = 0;
        while (history.undoMetadata()) {
            undoCount += 1;
        }

        expect(undoCount).toBe(maxWorkspaceMetadataHistoryEntries - 1);
        expect(bookmarkItems.value).toEqual([]);
        expect(bookmarksDirty.value).toBe(false);
        expect(history.canUndoMetadata.value).toBe(false);
    });
});
