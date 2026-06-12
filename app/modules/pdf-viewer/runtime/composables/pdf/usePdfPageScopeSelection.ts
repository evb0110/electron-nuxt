import { normalizeSelectedPageNumbers } from '@app/utils/pdfPageSelection';

type TPdfPageScope = 'all' | 'current' | 'selected' | 'range';

interface IPdfPageScopeSelectionOptions {
    totalPages: () => number;
    currentPage: () => number;
    selectedPages: () => number[];
    resolveRangePages: () => number[] | null;
}

export const usePdfPageScopeSelection = (options: IPdfPageScopeSelectionOptions) => {
    const scope = ref<TPdfPageScope>('all');
    const rangeInput = ref('');
    const rangeTouched = ref(false);

    const normalizedSelectedPages = computed(() =>
        normalizeSelectedPageNumbers(options.selectedPages(), options.totalPages()));

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
        resetScopeForOpen,
        resolveScopedPageNumbers,
    };
};
