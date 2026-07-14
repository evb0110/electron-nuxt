import type { Ref } from 'vue';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';

interface IPdfSearchPageResult {pageIndex: number}

/** Routes PDF result selection through the same workspace navigation authority as every other format. */
export function createWorkspacePdfSearchResultNavigation(options: {
    results: Readonly<Ref<readonly IPdfSearchPageResult[]>>;
    navigate: (page: number, scrollOptions?: IScrollToPageOptions) => void;
    select: (index: number) => void;
}) {
    return (index: number) => {
        const result = options.results.value[index];
        if (result) options.navigate(result.pageIndex + 1, {navigationSource: 'search'});
        options.select(index);
    };
}
