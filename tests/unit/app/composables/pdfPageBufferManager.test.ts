import {
    describe,
    expect,
    it,
} from 'vitest';
import { getPageContainer } from '@app/composables/pdf/pdfPageBufferManager';

function cast<T>(value: unknown): T {
    return value as T;
}

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
});
