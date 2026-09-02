import type { Ref } from 'vue';

interface IPdfSearchPageResult {pageIndex: number}

/** Selects a PDF result so the viewer can issue one centered, exact-match navigation request. */
export function createWorkspacePdfSearchResultNavigation(options: {
    results: Readonly<Ref<readonly IPdfSearchPageResult[]>>;
    select: (index: number) => void;
}) {
    return (index: number) => {
        const result = options.results.value[index];
        if (result) {
            options.select(index);
        }
    };
}
