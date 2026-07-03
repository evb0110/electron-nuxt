import {
    canSyncDocumentViewportNavigationFromViewport,
    createDocumentViewportNavigationMachineState,
    getDocumentViewportNavigationStatusForSource,
    getDocumentViewportNavigationTargetPageForSource,
    getDocumentViewportNavigationTxnForSource,
    isDocumentViewportNavigationTargetCurrent,
    isDocumentViewportNavigationTxnCurrent,
    reduceDocumentViewportNavigationMachine,
    type IDocumentViewportNavigationState,
    type TDocumentViewportNavigationAnchor,
    type TDocumentViewportNavigationEvent,
    type TDocumentViewportNavigationSource,
} from '@app/utils/document-viewer/viewport/documentViewportNavigationMachine';

type TDocumentViewportCurrentPageCommitter = (
    page: number,
    options: {
        previousPage?: number | undefined;
        transactionId?: number | undefined;
    },
) => boolean | undefined;

interface IDocumentViewportNavigationRuntimeOptions<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
> {
    initialState?: IDocumentViewportNavigationState<TSource, TAnchor> | undefined;
    commitCurrentPage?: TDocumentViewportCurrentPageCommitter | undefined;
    onCurrentPageChanged?: ((page: number, previousPage: number | null) => void) | undefined;
    onStateChanged?: ((state: IDocumentViewportNavigationState<TSource, TAnchor>) => void) | undefined;
}

interface IDocumentViewportCurrentPageCommitOptions {previousPage?: number | undefined;}

function getNavigationRuntimeCurrentPage(
    state: { currentPage: number | null },
    previousPage?: number | undefined,
) {
    return previousPage ?? state.currentPage ?? null;
}

export function createDocumentViewportNavigationRuntime<
    TSource extends string = TDocumentViewportNavigationSource,
    TAnchor extends string = TDocumentViewportNavigationAnchor,
>(
    options: IDocumentViewportNavigationRuntimeOptions<TSource, TAnchor> = {},
) {
    let state = options.initialState ?? createDocumentViewportNavigationMachineState<TSource, TAnchor>();

    function applyCurrentPageFromState(previousPage?: number | undefined) {
        if (state.currentPage === null) {
            return false;
        }

        const previous = getNavigationRuntimeCurrentPage(state, previousPage);
        const transactionId = state.status === 'idle'
            ? undefined
            : state.txn;
        const didCommit = options.commitCurrentPage?.(
            state.currentPage,
            transactionId !== undefined
                ? {
                    previousPage: previous ?? undefined,
                    transactionId,
                }
                : { previousPage: previous ?? undefined },
        );
        if (didCommit !== undefined) {
            return didCommit;
        }
        if (state.currentPage !== previous) {
            options.onCurrentPageChanged?.(state.currentPage, previous);
            return true;
        }
        return false;
    }

    function dispatch(
        event: TDocumentViewportNavigationEvent<TSource, TAnchor>,
        commitOptions: IDocumentViewportCurrentPageCommitOptions = {},
    ) {
        const previousPage = commitOptions.previousPage ?? state.currentPage ?? undefined;
        state = reduceDocumentViewportNavigationMachine(state, event);
        applyCurrentPageFromState(previousPage);
        options.onStateChanged?.(state);
        return state;
    }

    function getState() {
        return state;
    }

    function isTxnCurrent(candidateTxn: number) {
        return isDocumentViewportNavigationTxnCurrent(state, candidateTxn);
    }

    function getStatusForSource(candidateSource: TSource) {
        return getDocumentViewportNavigationStatusForSource(state, candidateSource);
    }

    function getTargetPageForSource(candidateSource: TSource) {
        return getDocumentViewportNavigationTargetPageForSource(state, candidateSource);
    }

    function getTxnForSource(candidateSource: TSource) {
        return getDocumentViewportNavigationTxnForSource(state, candidateSource);
    }

    function isTargetCurrent(
        candidateSource: TSource,
        candidateTxn: number,
        candidateTargetPage: number,
    ) {
        return isDocumentViewportNavigationTargetCurrent(
            state,
            candidateSource,
            candidateTxn,
            candidateTargetPage,
        );
    }

    function canSyncCurrentPageFromViewport() {
        return canSyncDocumentViewportNavigationFromViewport(state);
    }

    function commitViewportCurrentPage(
        page: number,
        commitOptions: IDocumentViewportCurrentPageCommitOptions = {},
    ) {
        if (!canSyncCurrentPageFromViewport()) {
            return false;
        }

        const previousState = state;
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
        candidateSource: TSource,
        candidateTxn: number,
        candidateTargetPage: number,
        commitOptions: IDocumentViewportCurrentPageCommitOptions = {},
    ) {
        if (!isTargetCurrent(candidateSource, candidateTxn, candidateTargetPage)) {
            return false;
        }

        const previousState = state;
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
        getState,
        dispatch,
        isTxnCurrent,
        getStatusForSource,
        getTargetPageForSource,
        getTxnForSource,
        isTargetCurrent,
        canSyncCurrentPageFromViewport,
        commitViewportCurrentPage,
        commitNavigationCurrentPage,
    };
}
