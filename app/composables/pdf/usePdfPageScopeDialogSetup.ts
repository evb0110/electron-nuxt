import { usePdfPageScopeSelection } from '@app/composables/pdf/usePdfPageScopeSelection';

interface IPdfPageScopeDialogProps {
    totalPages: number;
    currentPage: number;
    selectedPages: number[];
}

export function usePdfPageScopeDialogSetup(
    props: IPdfPageScopeDialogProps,
    resolveRangePages: () => number[] | null,
) {
    return usePdfPageScopeSelection({
        totalPages: () => props.totalPages,
        currentPage: () => props.currentPage,
        selectedPages: () => props.selectedPages,
        resolveRangePages,
    });
}
