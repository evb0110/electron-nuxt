import {
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

export function createPdfNavigationRuntime() {
    const state = shallowRef<IPdfNavigationState>(createPdfNavigationMachineState());
    const status = computed(() => state.value.status);
    const targetPage = computed(() => state.value.targetPage);
    const source = computed(() => state.value.source);
    const txn = computed(() => state.value.txn);

    function dispatch(event: TPdfNavigationEvent) {
        state.value = reducePdfNavigationMachine(state.value, event);
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
    };
}
