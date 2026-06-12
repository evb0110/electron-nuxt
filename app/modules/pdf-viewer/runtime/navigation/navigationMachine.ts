import type { TPageSnapAnchor } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';

export type TPdfNavigationSource =
    | 'paged'
    | 'continuous'
    | 'search'
    | 'wheel';

export type TPdfNavigationStatus =
    | 'idle'
    | 'navigating'
    | 'settling';

export interface IPdfNavigationState {
    anchor: TPageSnapAnchor | null;
    source: TPdfNavigationSource | null;
    status: TPdfNavigationStatus;
    targetPage: number | null;
    txn: number;
}

interface IPdfNavigateEvent {
    anchor?: TPageSnapAnchor | null | undefined;
    source: TPdfNavigationSource;
    targetPage: number;
    type: 'NAVIGATE';
}

interface IPdfNavigationTxnPageEvent {
    page: number;
    txn: number;
}

interface IPdfNavigationScrollAppliedEvent extends IPdfNavigationTxnPageEvent { type: 'SCROLL_APPLIED' }

interface IPdfNavigationRenderSettledEvent extends IPdfNavigationTxnPageEvent { type: 'RENDER_SETTLED' }

interface IPdfNavigationCancelEvent { type: 'CANCEL' | 'DOCUMENT_CHANGED' | 'USER_SCROLL' }

export type TPdfNavigationEvent =
    | IPdfNavigateEvent
    | IPdfNavigationScrollAppliedEvent
    | IPdfNavigationRenderSettledEvent
    | IPdfNavigationCancelEvent;

export function createPdfNavigationMachineState(txn = 0): IPdfNavigationState {
    return {
        anchor: null,
        source: null,
        status: 'idle',
        targetPage: null,
        txn,
    };
}

function eventMatchesCurrentTarget(
    state: IPdfNavigationState,
    event: IPdfNavigationTxnPageEvent,
) {
    return state.txn === event.txn && state.targetPage === event.page;
}

export function reducePdfNavigationMachine(
    state: IPdfNavigationState,
    event: TPdfNavigationEvent,
): IPdfNavigationState {
    switch (event.type) {
        case 'NAVIGATE':
            return {
                anchor: event.anchor ?? null,
                source: event.source,
                status: 'navigating',
                targetPage: event.targetPage,
                txn: state.txn + 1,
            };
        case 'SCROLL_APPLIED':
            if (state.status !== 'navigating' || !eventMatchesCurrentTarget(state, event)) {
                return state;
            }
            return {
                ...state,
                status: 'settling',
            };
        case 'RENDER_SETTLED':
            if (
                (state.status !== 'navigating' && state.status !== 'settling')
                || !eventMatchesCurrentTarget(state, event)
            ) {
                return state;
            }
            return createPdfNavigationMachineState(state.txn);
        case 'CANCEL':
        case 'DOCUMENT_CHANGED':
        case 'USER_SCROLL':
            return createPdfNavigationMachineState(state.txn + 1);
    }
}

export function isPdfNavigationTxnCurrent(
    state: IPdfNavigationState,
    txn: number,
) {
    return state.txn === txn && state.status !== 'idle';
}

export function canSyncPdfNavigationFromViewport(state: IPdfNavigationState) {
    return state.status === 'idle';
}
