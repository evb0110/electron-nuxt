import type { TPageSnapAnchor } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';
import {
    canSyncDocumentViewportNavigationFromViewport,
    createDocumentViewportNavigationMachineState,
    createDocumentViewportNavigationRenderSettledEvent,
    getDocumentViewportNavigationStatusForSource,
    getDocumentViewportNavigationTargetPageForSource,
    getDocumentViewportNavigationTxnForSource,
    isDocumentViewportNavigationTargetCurrent,
    isDocumentViewportNavigationTxnCurrent,
    reduceDocumentViewportNavigationMachine,
    type IDocumentViewportNavigationState,
    type TDocumentViewportNavigationEvent,
} from '@app/utils/document-viewer/viewport/documentViewportNavigationMachine';

export type TPdfNavigationSource =
    | 'paged'
    | 'continuous'
    | 'search'
    | 'wheel';

export interface IPdfNavigationState extends IDocumentViewportNavigationState<TPdfNavigationSource, TPageSnapAnchor> {}

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

export type TPdfNavigationEvent = TDocumentViewportNavigationEvent<TPdfNavigationSource, TPageSnapAnchor>
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
    return createDocumentViewportNavigationRenderSettledEvent<TPdfNavigationSource, TPageSnapAnchor>(txn, page);
}

export function createPdfNavigationMachineState(
    txn = 0,
    currentPage: number | null = null,
): IPdfNavigationState {
    return createDocumentViewportNavigationMachineState<TPdfNavigationSource, TPageSnapAnchor>(txn, currentPage);
}

export function reducePdfNavigationMachine(
    state: IPdfNavigationState,
    event: TPdfNavigationEvent,
): IPdfNavigationState {
    return reduceDocumentViewportNavigationMachine(state, event);
}

export function isPdfNavigationTxnCurrent(
    state: IPdfNavigationState,
    txn: number,
) {
    return isDocumentViewportNavigationTxnCurrent(state, txn);
}

export function getPdfNavigationStatusForSource(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
) {
    return getDocumentViewportNavigationStatusForSource(state, source);
}

export function getPdfNavigationTargetPageForSource(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
) {
    return getDocumentViewportNavigationTargetPageForSource(state, source);
}

export function getPdfNavigationTxnForSource(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
) {
    return getDocumentViewportNavigationTxnForSource(state, source);
}

export function isPdfNavigationTargetCurrent(
    state: IPdfNavigationState,
    source: TPdfNavigationSource,
    txn: number,
    targetPage: number,
) {
    return isDocumentViewportNavigationTargetCurrent(state, source, txn, targetPage);
}

export function canSyncPdfNavigationFromViewport(state: IPdfNavigationState) {
    return canSyncDocumentViewportNavigationFromViewport(state);
}
