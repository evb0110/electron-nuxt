import {
    describe,
    expect,
    it,
} from 'vitest';
import { getPageContainer } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/getPageContainer';
import { setupPagePlaceholderSizes } from '@app/modules/pdf-viewer/engine/pdf-page-buffer-manager/setupPagePlaceholderSizes';
import { cast } from '@tests/helpers/cast';

function createPageContainerRoot(pageNumbers: number[]) {
    const mountedPages = pageNumbers.map((pageNumber) => cast<HTMLElement>({dataset: {page: String(pageNumber)}}));

    return cast<HTMLElement>({
        querySelector: (selector: string) => {
            const match = selector.match(/\.page_container\[data-page="(\d+)"\]/);
            if (!match?.[1]) {
                return null;
            }
            const targetPage = Number.parseInt(match[1], 10);
            return mountedPages.find((pageContainer) => {
                const pageNumber = Number.parseInt(pageContainer.dataset.page ?? '', 10);
                return pageNumber === targetPage;
            }) ?? null;
        },
        querySelectorAll: (selector: string) => (
            selector === '.page_container' ? mountedPages : []
        ),
    });
}

describe('pdfPageBufferManager.getPageContainer', () => {
    it('finds mounted page containers by data-page', () => {
        const root = createPageContainerRoot([
            41,
            44,
        ]);

        const page41 = getPageContainer(root, 40);
        const page44 = getPageContainer(root, 43);

        expect(page41?.dataset.page).toBe('41');
        expect(page44?.dataset.page).toBe('44');
    });

    it('does not use positional fallback when target page is not mounted', () => {
        const root = createPageContainerRoot([
            41,
            44,
        ]);

        expect(getPageContainer(root, 0)).toBeNull();
    });

    it('sizes mounted placeholders from each page metric instead of one shared size', () => {
        const containers = [
            cast<HTMLElement>({
                dataset: { page: '1' },
                style: {},
            }),
            cast<HTMLElement>({
                dataset: { page: '2' },
                style: {},
            }),
        ];

        const root = cast<HTMLElement>({ querySelectorAll: (selector: string) => (
            selector === '.page_container' ? containers : []
        ) });

        setupPagePlaceholderSizes(root, [
            {
                width: 100,
                height: 200,
            },
            {
                width: 50,
                height: 80,
            },
        ], 2);

        expect(containers[0]?.style.width).toBe('200px');
        expect(containers[0]?.style.height).toBe('400px');
        expect(containers[1]?.style.width).toBe('100px');
        expect(containers[1]?.style.height).toBe('160px');
    });
});
