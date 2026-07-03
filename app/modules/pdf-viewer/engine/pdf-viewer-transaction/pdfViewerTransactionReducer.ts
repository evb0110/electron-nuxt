import type {
    IPdfViewerTransaction,
    IPdfViewerTransactionCancellation,
    IPdfViewerTransactionMachineState,
    TPdfViewerTransactionEvent,
    TPdfViewerTransactionKind,
    TPdfViewerTransactionPriority,
    TPdfViewerTransactionState,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

const AUTHORITATIVE_TRANSACTION_KINDS = new Set<TPdfViewerTransactionKind>([
    'navigation',
    'rerender',
    'reload',
    'resize',
    'zoom',
    'search',
]);

const PDF_VIEWER_TRANSACTION_STATE_ORDER = {
    preparing: 0,
    'layout-ready': 1,
    'visible-range-committed': 2,
    'scroll-applied': 3,
    'render-requested': 4,
    'render-settled': 5,
    'current-page-committed': 6,
    settled: 7,
    cancelled: 8,
} satisfies Record<TPdfViewerTransactionState, number>;

export function createPdfViewerTransactionMachineState(
    options: Partial<IPdfViewerTransactionMachineState> = {},
): IPdfViewerTransactionMachineState {
    return {
        active: options.active ?? null,
        cancelled: options.cancelled ?? [],
        settled: options.settled ?? null,
        nextTransactionId: options.nextTransactionId ?? 1,
        nextRenderRequestId: options.nextRenderRequestId ?? 1,
        renderVersion: options.renderVersion ?? 0,
    };
}

function getPdfViewerTransactionPriority(
    transaction: Pick<IPdfViewerTransaction, 'kind' | 'renderRequest'>,
): TPdfViewerTransactionPriority {
    if (transaction.renderRequest) {
        return transaction.renderRequest.priority;
    }
    if (transaction.kind === 'warm') {
        return 'warm';
    }
    if (transaction.kind === 'recovery') {
        return 'recovery';
    }
    if (transaction.kind === 'zoom' || transaction.kind === 'resize') {
        return 'interactive';
    }
    return 'authoritative';
}

function isPdfViewerTransactionAuthoritative(
    transaction: Pick<IPdfViewerTransaction, 'kind' | 'renderRequest'> | null,
) {
    return Boolean(transaction && AUTHORITATIVE_TRANSACTION_KINDS.has(transaction.kind));
}

function isPdfViewerTransactionCurrent(
    state: IPdfViewerTransactionMachineState,
    transactionId: number,
) {
    return state.active?.id === transactionId
        && state.active.state !== 'cancelled'
        && state.active.state !== 'settled';
}

export function canPdfViewerTransactionSupersede(
    active: IPdfViewerTransaction | null,
    incoming: Pick<IPdfViewerTransaction, 'kind' | 'renderRequest'>,
) {
    if (!active) {
        return true;
    }
    const incomingPriority = getPdfViewerTransactionPriority(incoming);
    if (
        isPdfViewerTransactionAuthoritative(active)
        && (incomingPriority === 'warm' || incomingPriority === 'recovery')
    ) {
        return false;
    }
    return true;
}

function cancelTransaction(
    transaction: IPdfViewerTransaction,
    cancellation: IPdfViewerTransactionCancellation,
): IPdfViewerTransaction {
    return {
        ...transaction,
        state: 'cancelled',
        cancellation,
    };
}

function createSupersededCancellation(
    supersededByTransactionId: number,
): IPdfViewerTransactionCancellation {
    return {
        reason: 'superseded',
        supersededByTransactionId,
        cancelInFlightRenders: true,
        bumpRenderVersion: false,
        clearTimers: true,
        preserveVisualContent: true,
    };
}

function isForwardStateChange(
    currentState: TPdfViewerTransactionState,
    nextState: TPdfViewerTransactionState,
) {
    const currentOrder = PDF_VIEWER_TRANSACTION_STATE_ORDER[currentState];
    const nextOrder = PDF_VIEWER_TRANSACTION_STATE_ORDER[nextState];
    return nextOrder >= currentOrder;
}

export function reducePdfViewerTransactionMachine(
    state: IPdfViewerTransactionMachineState,
    event: TPdfViewerTransactionEvent,
): IPdfViewerTransactionMachineState {
    switch (event.type) {
        case 'BEGIN': {
            const id = event.transaction.id ?? state.nextTransactionId;
            const nextTransaction: IPdfViewerTransaction = {
                ...event.transaction,
                id,
                state: event.transaction.state ?? 'preparing',
                renderRequest: event.transaction.renderRequest ?? null,
                cancellation: null,
            };
            if (!canPdfViewerTransactionSupersede(state.active, nextTransaction)) {
                return state;
            }

            const cancelled = state.active
                ? [
                    ...state.cancelled,
                    cancelTransaction(state.active, createSupersededCancellation(id)),
                ]
                : state.cancelled;
            return {
                ...state,
                active: nextTransaction,
                cancelled,
                settled: null,
                nextTransactionId: Math.max(state.nextTransactionId, id + 1),
            };
        }
        case 'ADVANCE': {
            if (!isPdfViewerTransactionCurrent(state, event.transactionId) || !state.active) {
                return state;
            }
            if (!isForwardStateChange(state.active.state, event.state)) {
                return state;
            }

            const active: IPdfViewerTransaction = {
                ...state.active,
                state: event.state,
                renderRequest: event.renderRequest === undefined
                    ? state.active.renderRequest
                    : event.renderRequest,
            };
            const nextRenderRequestId = event.renderRequest
                ? Math.max(state.nextRenderRequestId, event.renderRequest.renderRequestId + 1)
                : state.nextRenderRequestId;
            if (event.state === 'settled') {
                return {
                    ...state,
                    active: null,
                    settled: active,
                    nextRenderRequestId,
                };
            }
            return {
                ...state,
                active,
                nextRenderRequestId,
            };
        }
        case 'CANCEL': {
            if (!state.active) {
                return event.cancellation.bumpRenderVersion
                    ? {
                        ...state,
                        renderVersion: state.renderVersion + 1,
                    }
                    : state;
            }
            if (
                event.transactionId !== undefined
                && event.transactionId !== state.active.id
            ) {
                return state;
            }

            return {
                ...state,
                active: null,
                cancelled: [
                    ...state.cancelled,
                    cancelTransaction(state.active, event.cancellation),
                ],
                renderVersion: event.cancellation.bumpRenderVersion
                    ? state.renderVersion + 1
                    : state.renderVersion,
            };
        }
    }
}
