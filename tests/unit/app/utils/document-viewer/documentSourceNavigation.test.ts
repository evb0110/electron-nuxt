import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createDocumentBookmarkTree,
    findDocumentBookmark,
    getDocumentBookmarkActivePath,
} from '@app/utils/document-viewer/bookmarks/documentBookmarks';

describe('document source navigation providers', () => {
    it('preserves nested source outlines as stable common bookmark trees', () => {
        const tree = createDocumentBookmarkTree([{
            title: 'Part',
            pageNumber: 1,
            children: [{
                title: 'Chapter',
                pageNumber: 2,
                children: [],
            }],
        }]);

        expect(tree).toEqual([{
            id: 'document-bookmark-0',
            title: 'Part',
            pageNumber: 1,
            children: [{
                id: 'document-bookmark-0-0',
                title: 'Chapter',
                pageNumber: 2,
                children: [],
            }],
        }]);
        expect(findDocumentBookmark(tree, 'document-bookmark-0-0')?.title).toBe('Chapter');
    });

    it('resolves the active bookmark and every ancestor from the current page', () => {
        const tree = createDocumentBookmarkTree([{
            title: 'Part',
            pageNumber: 3,
            children: [
                {
                    title: 'First chapter',
                    pageNumber: 5,
                    children: [],
                },
                {
                    title: 'Second chapter',
                    pageNumber: 12,
                    children: [],
                },
            ],
        }]);

        expect(getDocumentBookmarkActivePath(tree, 8)).toEqual([
            'document-bookmark-0',
            'document-bookmark-0-0',
        ]);
        expect(getDocumentBookmarkActivePath(tree, 2)).toEqual([]);
    });
});
