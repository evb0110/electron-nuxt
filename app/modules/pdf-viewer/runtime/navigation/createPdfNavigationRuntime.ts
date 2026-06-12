import {
    createPdfNavigationMachineState,
    isPdfNavigationTxnCurrent,
    reducePdfNavigationMachine,
} from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';
import type {
    IPdfNavigationState,
    TPdfNavigationEvent,
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

    return {
        state,
        dispatch,
        status,
        targetPage,
        source,
        txn,
        isTxnCurrent,
    };
}
