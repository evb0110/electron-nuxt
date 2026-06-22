import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { navigateToBookmarkDestination } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/navigateToBookmarkDestination';
import { resolveBookmarkDestinationTarget } from '@app/utils/pdfOutlineHelpers';
import type * as PdfOutlineHelpers from '@app/utils/pdfOutlineHelpers';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/utils/pdfOutlineHelpers', async (importOriginal) => {
    const actual = await importOriginal<typeof PdfOutlineHelpers>();
    return {
        ...actual,
        resolveBookmarkDestinationTarget: vi.fn(),
    };
});

interface IDeferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function createDeferred<T>(): IDeferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return {
        promise,
        resolve,
    };
}

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
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('ignores a stale async destination after a newer bookmark request starts', async () => {
        const firstDestination = createDeferred<{
            page: number;
            pageYRatio?: number
        } | null>();
        const secondDestination = createDeferred<{
            page: number;
            pageYRatio?: number
        } | null>();
        vi.mocked(resolveBookmarkDestinationTarget)
            .mockReturnValueOnce(firstDestination.promise)
            .mockReturnValueOnce(secondDestination.promise);

        let currentRequestId = 1;
        const emitGoToPage = vi.fn();
        const pdfDocument = cast<PDFDocumentProxy>({});
        const firstNavigation = navigateToBookmarkDestination({
            item: createBookmark({
                dest: 'first-dest',
                id: 'first',
                pageIndex: 0,
            }),
            pdfDocument,
            navigationRequestId: 1,
            isBookmarkNavigationRequestCurrent: requestId => requestId === currentRequestId,
            emitGoToPage,
        });

        currentRequestId = 2;
        const secondNavigation = navigateToBookmarkDestination({
            item: createBookmark({
                dest: 'second-dest',
                id: 'second',
                pageIndex: 4,
            }),
            pdfDocument,
            navigationRequestId: 2,
            isBookmarkNavigationRequestCurrent: requestId => requestId === currentRequestId,
            emitGoToPage,
        });

        expect(emitGoToPage).toHaveBeenNthCalledWith(1, 1, { pageYRatio: 0 });
        expect(emitGoToPage).toHaveBeenNthCalledWith(2, 5, { pageYRatio: 0 });

        firstDestination.resolve({
            page: 9,
            pageYRatio: 0.5,
        });
        await firstNavigation;
        secondDestination.resolve(null);
        await secondNavigation;

        expect(emitGoToPage).toHaveBeenCalledTimes(2);
    });
});
