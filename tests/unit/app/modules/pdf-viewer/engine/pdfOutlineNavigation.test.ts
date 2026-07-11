import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { navigateToBookmarkDestination } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/navigateToBookmarkDestination';
import type { IBookmarkItem } from '@app/types/pdfOutline';

function createBookmark(overrides: Partial<IBookmarkItem>): IBookmarkItem {
    return {
        bold: false,
        color: null,
        dest: null,
        id: 'bookmark',
        italic: false,
        items: [],
        pageIndex: null,
        title: 'Bookmark',
        ...overrides,
    };
}

describe('navigateToBookmarkDestination', () => {
    it('emits one unresolved named destination for the authority', () => {
        const emitGoToPage = vi.fn();
        navigateToBookmarkDestination({
            item: createBookmark({
                dest: 'chapter',
                pageIndex: 4,
            }),
            pdfDocument: null,
            navigationRequestId: 2,
            isBookmarkNavigationRequestCurrent: id => id === 2,
            emitGoToPage,
        });
        expect(emitGoToPage).toHaveBeenCalledOnce();
        expect(emitGoToPage).toHaveBeenCalledWith(5, {navigationRequest: {
            target: {
                kind: 'named-dest',
                destination: 'chapter',
            },
            alignment: 'page-top',
            readiness: 'page-canvas',
            source: 'bookmark',
            supersession: 'latest-wins',
        }});
    });

    it('emits a page target when the bookmark has no named destination', () => {
        const emitGoToPage = vi.fn();
        navigateToBookmarkDestination({
            item: createBookmark({pageIndex: 6}),
            pdfDocument: null,
            navigationRequestId: 1,
            isBookmarkNavigationRequestCurrent: () => true,
            emitGoToPage,
        });
        expect(emitGoToPage).toHaveBeenCalledWith(7, {navigationRequest: expect.objectContaining({
            target: {
                kind: 'page',
                page: 7,
            },
            source: 'bookmark',
        })});
    });

    it('does not emit stale or invalid requests', () => {
        const emitGoToPage = vi.fn();
        const common = {
            pdfDocument: null,
            navigationRequestId: 1,
            emitGoToPage,
        };
        navigateToBookmarkDestination({
            ...common,
            item: createBookmark({dest: 'stale'}),
            isBookmarkNavigationRequestCurrent: () => false,
        });
        navigateToBookmarkDestination({
            ...common,
            item: createBookmark({pageIndex: Number.NaN}),
            isBookmarkNavigationRequestCurrent: () => true,
        });
        expect(emitGoToPage).not.toHaveBeenCalled();
    });
});
