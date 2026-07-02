import {
    canSyncPdfNavigationFromViewport,
    createPdfNavigationMachineState,
    getPdfNavigationStatusForSource,
    getPdfNavigationTargetPageForSource,
    getPdfNavigationTxnForSource,
    isPdfNavigationTargetCurrent,
    isPdfNavigationTxnCurrent,
    reducePdfNavigationMachine,
} from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';
import type {
    IPdfNavigationState,
    TPdfNavigationEvent,
    TPdfNavigationSource,
} from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';
import type { Ref } from 'vue';

type TPdfCurrentPageEmitter = (page: number) => void;

interface IPdfNavigationRuntimeOptions {
    currentPage?: Ref<number> | undefined;
    emitCurrentPage?: TPdfCurrentPageEmitter | undefined;
}

interface IPdfCurrentPageCommitOptions { previousPage?: number | undefined }

interface IPdfViewportCurrentPageCommitOptions extends IPdfCurrentPageCommitOptions { source?: string | undefined }

export function createPdfNavigationRuntime(options: IPdfNavigationRuntimeOptions = {}) {
    const state = shallowRef<IPdfNavigationState>(
        createPdfNavigationMachineState(0, options.currentPage?.value ?? null),
    );
    const status = computed(() => state.value.status);
    const targetPage = computed(() => state.value.targetPage);
    const source = computed(() => state.value.source);
    const txn = computed(() => state.value.txn);

    function applyCurrentPageFromState(previousPage?: number) {
        const currentPage = state.value.currentPage;
        if (currentPage === null || !options.currentPage) {
            return false;
        }

        const previous = previousPage ?? options.currentPage.value;
        if (options.currentPage.value !== currentPage) {
            options.currentPage.value = currentPage;
        }
        if (currentPage !== previous) {
            options.emitCurrentPage?.(currentPage);
            return true;
        }
        return false;
    }

    function dispatch(
        event: TPdfNavigationEvent,
        commitOptions: IPdfCurrentPageCommitOptions = {},
    ) {
        const previousPage = commitOptions.previousPage ?? options.currentPage?.value;
        state.value = reducePdfNavigationMachine(state.value, event);
        applyCurrentPageFromState(previousPage);
        return state.value;
    }

    function isTxnCurrent(candidateTxn: number) {
        return isPdfNavigationTxnCurrent(state.value, candidateTxn);
    }

    function statusForSource(candidateSource: TPdfNavigationSource) {
        return computed(() => getPdfNavigationStatusForSource(
            state.value,
            candidateSource,
        ));
    }

    function targetPageForSource(candidateSource: TPdfNavigationSource) {
        return computed(() => getPdfNavigationTargetPageForSource(
            state.value,
            candidateSource,
        ));
    }

    function getTxnForSource(candidateSource: TPdfNavigationSource) {
        return getPdfNavigationTxnForSource(state.value, candidateSource);
    }

    function isTargetCurrent(
        candidateSource: TPdfNavigationSource,
        candidateTxn: number,
        candidateTargetPage: number,
    ) {
        return isPdfNavigationTargetCurrent(
            state.value,
            candidateSource,
            candidateTxn,
            candidateTargetPage,
        );
    }

    function canSyncCurrentPageFromViewport() {
        return canSyncPdfNavigationFromViewport(state.value);
    }

    function commitViewportCurrentPage(
        page: number,
        commitOptions: IPdfViewportCurrentPageCommitOptions = {},
    ) {
        if (!canSyncCurrentPageFromViewport()) {
            return false;
        }

        const previousState = state.value;
        const nextState = dispatch(
            {
                type: 'VIEWPORT_CURRENT_PAGE',
                page,
            },
            commitOptions,
        );
        return nextState !== previousState || nextState.currentPage === page;
    }

    function commitNavigationCurrentPage(
        candidateSource: TPdfNavigationSource,
        candidateTxn: number,
        candidateTargetPage: number,
        commitOptions: IPdfCurrentPageCommitOptions = {},
    ) {
        if (!isTargetCurrent(candidateSource, candidateTxn, candidateTargetPage)) {
            return false;
        }

        const previousState = state.value;
        const nextState = dispatch(
            {
                type: 'CURRENT_PAGE_COMMITTED',
                txn: candidateTxn,
                page: candidateTargetPage,
            },
            commitOptions,
        );
        return nextState !== previousState || nextState.currentPage === candidateTargetPage;
    }

    return {
        state,
        dispatch,
        status,
        targetPage,
        source,
        txn,
        isTxnCurrent,
        statusForSource,
        targetPageForSource,
        getTxnForSource,
        isTargetCurrent,
        canSyncCurrentPageFromViewport,
        commitViewportCurrentPage,
        commitNavigationCurrentPage,
    };
}

export function createPdfNavigationRuntimeForCurrentPage(
    currentPage: Ref<number>,
    emitCurrentPage?: TPdfCurrentPageEmitter | undefined,
) {
    return createPdfNavigationRuntime({
        currentPage,
        emitCurrentPage,
    });
}
