import { normalizeSelectedPageNumbers } from '@app/utils/pdf-page-selection';

export type TPdfPageScope = 'all' | 'current' | 'selected' | 'range';

interface IPdfPageScopeSelectionOptions {
    totalPages: () => number;
    currentPage: () => number;
    selectedPages: () => number[];
    resolveRangePages: () => number[] | null;
}

export function usePdfPageScopeSelection(options: IPdfPageScopeSelectionOptions) {
    const scope = ref<TPdfPageScope>('all');
    const rangeInput = ref('');
    const rangeTouched = ref(false);

    const normalizedSelectedPages = computed(() =>
        normalizeSelectedPageNumbers(options.selectedPages(), options.totalPages()));

    const selectedPageCount = computed(() => {
        if (scope.value === 'all') {
            return options.totalPages();
        }
        if (scope.value === 'current') {
            return options.totalPages() > 0 ? 1 : 0;
        }
        if (scope.value === 'selected') {
            return normalizedSelectedPages.value.length;
        }
        return options.resolveRangePages()?.length ?? 0;
    });

    function resetScopeForOpen() {
        scope.value = normalizedSelectedPages.value.length > 0 ? 'selected' : 'all';
        rangeInput.value = '';
        rangeTouched.value = false;
    }

    function resolveScopedPageNumbers() {
        if (scope.value === 'current') {
            return [options.currentPage()];
        }
        if (scope.value === 'selected') {
            return normalizedSelectedPages.value;
        }
        if (scope.value === 'range') {
            return options.resolveRangePages() ?? undefined;
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
        selectedPageCount,
        resetScopeForOpen,
        resolveScopedPageNumbers,
    };
}
