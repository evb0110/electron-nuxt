import type { TPageSnapAnchor } from '@app/utils/document-viewer/single-page-wheel/singlePageWheelTypes';
import {
    createDocumentViewportNavigationMachineState,
    type IDocumentViewportNavigationState,
} from '@app/utils/document-viewer/viewport/documentViewportNavigationMachine';

export type TPdfNavigationSource =
    | 'paged'
    | 'continuous'
    | 'search'
    | 'wheel';

export interface IPdfNavigationState extends IDocumentViewportNavigationState<TPdfNavigationSource, TPageSnapAnchor> {}

export function createPdfNavigationMachineState(
    txn = 0,
    currentPage: number | null = null,
): IPdfNavigationState {
    return createDocumentViewportNavigationMachineState<TPdfNavigationSource, TPageSnapAnchor>(txn, currentPage);
}
