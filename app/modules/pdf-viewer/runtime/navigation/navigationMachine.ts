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
    currentPage: number | null;
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

interface IPdfNavigationCurrentPageCommittedEvent extends IPdfNavigationTxnPageEvent { type: 'CURRENT_PAGE_COMMITTED' }

interface IPdfNavigationViewportCurrentPageEvent {
    page: number;
    type: 'VIEWPORT_CURRENT_PAGE';
}

interface IPdfNavigationCancelEvent { type: 'CANCEL' | 'DOCUMENT_CHANGED' | 'USER_SCROLL' }

export type TPdfNavigationEvent =
    | IPdfNavigateEvent
    | IPdfNavigationScrollAppliedEvent
    | IPdfNavigationRenderSettledEvent
    | IPdfNavigationCurrentPageCommittedEvent
    | IPdfNavigationViewportCurrentPageEvent
    | IPdfNavigationCancelEvent;

export function createPdfNavigationRenderSettledEvent(
    txn: number,
    page: number,
): TPdfNavigationEvent {
    return {
        page,
        txn,
        type: 'RENDER_SETTLED',
    };
}

export function createPdfNavigationMachineState(
    txn = 0,
    currentPage: number | null = null,
): IPdfNavigationState {
    return {
        anchor: null,
        currentPage,
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
                currentPage: event.targetPage,
                source: event.source,
                status: 'navigating',
                targetPage: event.targetPage,
                txn: state.txn + 1,
            };
        case 'CURRENT_PAGE_COMMITTED':
            if (!eventMatchesCurrentTarget(state, event)) {
                return state;
            }
            return {
                ...state,
                currentPage: event.page,
            };
        case 'VIEWPORT_CURRENT_PAGE':
            if (!canSyncPdfNavigationFromViewport(state)) {
                return state;
            }
            return {
                ...state,
                currentPage: event.page,
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
            return createPdfNavigationMachineState(state.txn, state.currentPage);
        case 'CANCEL':
        case 'DOCUMENT_CHANGED':
        case 'USER_SCROLL':
            return createPdfNavigationMachineState(state.txn + 1, state.currentPage);
    }
}

export function isPdfNavigationTxnCurrent(
    state: IPdfNavigationState,
    txn: number,
) {
    return state.txn === txn && state.status !== 'idle';
}

export function getPdfNavigationStatusForSource(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
) {
    return state.source === source
        ? state.status
        : 'idle';
}

export function getPdfNavigationTargetPageForSource(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
) {
    return state.source === source && state.status !== 'idle'
        ? state.targetPage
        : null;
}

export function getPdfNavigationTxnForSource(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
) {
    return state.source === source && state.status !== 'idle'
        ? state.txn
        : null;
}

export function isPdfNavigationTargetCurrent(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
    txn: number,
    targetPage: number,
) {
    return state.source === source
        && state.status !== 'idle'
        && state.txn === txn
        && state.targetPage === targetPage;
}

export function canSyncPdfNavigationFromViewport(state: IPdfNavigationState) {
    return state.status === 'idle';
}
