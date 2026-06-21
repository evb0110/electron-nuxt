import {
    createAllPageNumbers,
    normalizeSelectedPageNumbers,
} from '@app/utils/pdfPageSelection';

type TPdfPageScope = 'all' | 'current' | 'selected' | 'range' | 'even' | 'odd';

interface IPdfPageScopeSelectionOptions {
    totalPages: () => number;
    currentPage: () => number;
    selectedPages: () => number[];
    resolveRangePages: () => number[] | null;
}

interface IResolveScopedPageNumbersOptions { includeAllPages?: boolean; }

export const usePdfPageScopeSelection = (options: IPdfPageScopeSelectionOptions) => {
    const scope = ref<TPdfPageScope>('all');
    const rangeInput = ref('');
    const rangeTouched = ref(false);

    const normalizedSelectedPages = computed(() =>
        normalizeSelectedPageNumbers(options.selectedPages(), options.totalPages()));

    function resetScopeForOpen(defaultScope?: TPdfPageScope) {
        scope.value = defaultScope ?? (normalizedSelectedPages.value.length > 0 ? 'selected' : 'all');
        rangeInput.value = '';
        rangeTouched.value = false;
    }

    function resolveScopedPageNumbers(
        resolveOptions: IResolveScopedPageNumbersOptions = {},
    ): number[] | undefined | null {
        if (scope.value === 'all') {
            return resolveOptions.includeAllPages ? createAllPageNumbers(options.totalPages()) : undefined;
        }
        if (scope.value === 'current') {
            const page = options.currentPage();
            return page >= 1 && page <= options.totalPages() ? [page] : null;
        }
        if (scope.value === 'even') {
            return createAllPageNumbers(options.totalPages()).filter(page => page % 2 === 0);
        }
        if (scope.value === 'odd') {
            return createAllPageNumbers(options.totalPages()).filter(page => page % 2 !== 0);
        }
        if (scope.value === 'selected') {
            return normalizedSelectedPages.value.length > 0 ? normalizedSelectedPages.value : null;
        }
        if (scope.value === 'range') {
            return options.resolveRangePages();
        }
        return undefined;
    }

    watch(normalizedSelectedPages, (pages) => {
        if (scope.value === 'selected' && pages.length === 0) {
            scope.value = 'all';
        }
    });

    watch(scope, () => {
        rangeTouched.value = false;
    });

    return {
        scope,
        rangeInput,
        rangeTouched,
        normalizedSelectedPages,
        resetScopeForOpen,
        resolveScopedPageNumbers,
    };
};
