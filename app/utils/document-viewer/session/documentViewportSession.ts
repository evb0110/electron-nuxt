import { assertDocumentViewportSessionInvariants } from '@app/utils/document-viewer/session/documentViewportSessionInvariants';
import type {
    IDocumentViewportCommitFence,
    IDocumentViewportIdentity,
    IDocumentViewportRenderFence,
    IDocumentViewportSessionState,
    IDocumentViewportSessionTransition,
    TDocumentViewportSessionEffect,
    TDocumentViewportSessionEvent,
    TDocumentViewportVisualOwner,
} from '@app/utils/document-viewer/session/documentViewportSession.types';

export type {
    IDocumentViewportCommitFence,
    IDocumentViewportIdentity,
    IDocumentViewportIntent,
    IDocumentViewportPreparedPage,
    IDocumentViewportRenderFence,
    IDocumentViewportSessionState,
    IDocumentViewportSessionTransition,
    IDocumentViewportSkeletonDelay,
    TDocumentViewportLifecycle,
    TDocumentViewportSessionEffect,
    TDocumentViewportSessionEvent,
    TDocumentViewportVisualOwner,
} from '@app/utils/document-viewer/session/documentViewportSession.types';
export {
    assertDocumentViewportSessionInvariants,
    canOpenRecentDocument,
    collectDocumentViewportSessionInvariantViolations,
} from '@app/utils/document-viewer/session/documentViewportSessionInvariants';

export function createEmptyDocumentViewportSession(
    generation = 0,
): IDocumentViewportSessionState {
    return assertDocumentViewportSessionInvariants({
        generation,
        identity: null,
        lifecycle: 'empty',
        requestedPage: 1,
        committedPage: null,
        pageCount: null,
        visual: {kind: 'empty'},
        viewportIntent: null,
        renderFence: null,
        committedRenderFence: null,
        committedViewportFence: null,
        skeletonDelay: null,
        failure: null,
    });
}

function isPositivePage(value: number) {
    return Number.isSafeInteger(value) && value >= 1;
}

function clampPage(pageNumber: number, pageCount: number | null) {
    return pageCount === null ? pageNumber : Math.min(pageCount, pageNumber);
}

function reject(state: IDocumentViewportSessionState): IDocumentViewportSessionTransition {
    return {
        state,
        effects: [],
        accepted: false,
    };
}

function accept(
    state: IDocumentViewportSessionState,
    effects: readonly TDocumentViewportSessionEffect[] = [],
): IDocumentViewportSessionTransition {
    return {
        state: assertDocumentViewportSessionInvariants(state),
        effects,
        accepted: true,
    };
}

function sameIdentityRevision(identity: IDocumentViewportIdentity | null, revision: string) {
    return identity?.revision === revision;
}

function renderFenceMatches(left: IDocumentViewportRenderFence, right: IDocumentViewportRenderFence) {
    return left.generation === right.generation
        && left.revision === right.revision
        && left.pageNumber === right.pageNumber
        && left.viewportIntentId === right.viewportIntentId
        && left.renderVersion === right.renderVersion
        && left.requestId === right.requestId;
}

function fenceTargetsCurrentIntent(
    state: IDocumentViewportSessionState,
    fence: IDocumentViewportRenderFence | IDocumentViewportCommitFence,
) {
    return fence.generation === state.generation
        && sameIdentityRevision(state.identity, fence.revision)
        && fence.pageNumber === state.requestedPage
        && fence.viewportIntentId === state.viewportIntent?.id;
}

function settleIfComplete(state: IDocumentViewportSessionState) {
    const render = state.committedRenderFence;
    const viewport = state.committedViewportFence;
    if (
        !render
        || !viewport
        || !fenceTargetsCurrentIntent(state, render)
        || !fenceTargetsCurrentIntent(state, viewport)
        || render.pageNumber !== viewport.pageNumber
    ) {
        return state;
    }
    return {
        ...state,
        lifecycle: 'ready' as const,
        committedPage: render.pageNumber,
        visual: {
            kind: 'page' as const,
            generation: state.generation,
            pageNumber: render.pageNumber,
            presentation: 'canvas' as const,
            frameKey: null,
            error: null,
        },
        skeletonDelay: null,
        failure: null,
    };
}

function openRequested(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'open-requested'}>,
) {
    if (
        event.identity.documentId.length === 0
        || event.identity.revision.length === 0
        || event.viewportIntentId.length === 0
        || (event.skeletonDelay && (
            event.skeletonDelay.token.length === 0
            || !Number.isFinite(event.skeletonDelay.deadline)
        ))
    ) {
        return reject(state);
    }
    const prepared = event.preparedPage;
    if (prepared && (
        !isPositivePage(prepared.pageNumber)
        || !isPositivePage(prepared.pageCount)
        || prepared.pageNumber > prepared.pageCount
        || prepared.frameKey.length === 0
    )) {
        return reject(state);
    }
    const initialPage = prepared?.pageNumber ?? event.initialPage ?? 1;
    if (!isPositivePage(initialPage)) {
        return reject(state);
    }

    const generation = state.generation + 1;
    const pageCount = prepared?.pageCount ?? null;
    const requestedPage = clampPage(initialPage, pageCount);
    const next: IDocumentViewportSessionState = {
        generation,
        identity: {...event.identity},
        lifecycle: 'opening',
        requestedPage,
        committedPage: null,
        pageCount,
        visual: {
            kind: 'page',
            generation,
            pageNumber: requestedPage,
            presentation: prepared ? 'prepared-shell' : 'cold-shell',
            frameKey: prepared?.frameKey ?? null,
            error: null,
        },
        viewportIntent: {
            generation,
            id: event.viewportIntentId,
            pageNumber: requestedPage,
        },
        renderFence: null,
        committedRenderFence: null,
        committedViewportFence: null,
        skeletonDelay: event.skeletonDelay ? {
            generation,
            token: event.skeletonDelay.token,
            pageNumber: requestedPage,
            deadline: event.skeletonDelay.deadline,
        } : null,
        failure: null,
    };
    const effects: TDocumentViewportSessionEffect[] = [];
    if (state.skeletonDelay) effects.push({
        type: 'cancel-skeleton-delay',
        token: state.skeletonDelay.token,
    });
    if (event.skeletonDelay) effects.push({
        type: 'schedule-skeleton-delay',
        generation,
        pageNumber: requestedPage,
        token: event.skeletonDelay.token,
        deadline: event.skeletonDelay.deadline,
    });
    return accept(next, effects);
}

function metadataReady(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'metadata-ready'}>,
) {
    if (event.generation !== state.generation || !isPositivePage(event.pageCount) || !state.identity) {
        return reject(state);
    }
    const requestedPage = clampPage(state.requestedPage, event.pageCount);
    const viewportIntent = state.viewportIntent && {
        ...state.viewportIntent,
        pageNumber: requestedPage,
    };
    let visual = state.visual;
    const skeletonDelay = state.skeletonDelay && {
        ...state.skeletonDelay,
        pageNumber: requestedPage,
    };
    if (visual.kind === 'page' && visual.presentation !== 'canvas') {
        visual = {
            ...visual,
            pageNumber: requestedPage,
        };
    }
    const next: IDocumentViewportSessionState = {
        ...state,
        requestedPage,
        pageCount: event.pageCount,
        visual,
        viewportIntent,
        skeletonDelay,
    };
    return accept(next);
}

function navigationRequested(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'navigation-requested'}>,
) {
    if (
        !state.identity
        || state.lifecycle === 'closing'
        || state.lifecycle === 'failed'
        || !isPositivePage(event.pageNumber)
        || event.viewportIntentId.length === 0
        || (event.skeletonDelay && (
            event.skeletonDelay.token.length === 0
            || !Number.isFinite(event.skeletonDelay.deadline)
        ))
    ) {
        return reject(state);
    }
    const pageNumber = clampPage(event.pageNumber, state.pageCount);
    const effects: TDocumentViewportSessionEffect[] = [];
    if (state.skeletonDelay) effects.push({
        type: 'cancel-skeleton-delay',
        token: state.skeletonDelay.token,
    });
    const visual: TDocumentViewportVisualOwner = {
        kind: 'page',
        generation: state.generation,
        pageNumber,
        presentation: event.skeletonDelay ? 'cold-shell' : 'skeleton',
        frameKey: null,
        error: null,
    };
    const next: IDocumentViewportSessionState = {
        ...state,
        lifecycle: state.lifecycle === 'opening' ? 'opening' : 'transitioning',
        requestedPage: pageNumber,
        visual,
        viewportIntent: {
            generation: state.generation,
            id: event.viewportIntentId,
            pageNumber,
        },
        renderFence: null,
        committedRenderFence: null,
        committedViewportFence: null,
        skeletonDelay: event.skeletonDelay ? {
            generation: state.generation,
            token: event.skeletonDelay.token,
            pageNumber,
            deadline: event.skeletonDelay.deadline,
        } : null,
        failure: null,
    };
    if (event.skeletonDelay) {
        effects.push({
            type: 'schedule-skeleton-delay',
            generation: state.generation,
            pageNumber,
            token: event.skeletonDelay.token,
            deadline: event.skeletonDelay.deadline,
        });
    }
    return accept(next, effects);
}

function reduceCommit(
    state: IDocumentViewportSessionState,
    event: Extract<TDocumentViewportSessionEvent, {type: 'canvas-committed' | 'viewport-committed'}>,
) {
    if (!fenceTargetsCurrentIntent(state, event.fence)) {
        return reject(state);
    }
    if (event.type === 'canvas-committed') {
        if (!state.renderFence || !renderFenceMatches(state.renderFence, event.fence)) {
            return reject(state);
        }
        const effects = state.skeletonDelay
            ? [{
                type: 'cancel-skeleton-delay' as const,
                token: state.skeletonDelay.token,
            }]
            : [];
        const next = settleIfComplete({
            ...state,
            committedRenderFence: event.fence,
            skeletonDelay: null,
        });
        return accept(next, effects);
    }
    return accept(settleIfComplete({
        ...state,
        committedViewportFence: event.fence,
    }));
}

export function reduceDocumentViewportSession(
    state: IDocumentViewportSessionState,
    event: TDocumentViewportSessionEvent,
): IDocumentViewportSessionTransition {
    switch (event.type) {
        case 'open-requested':
            return openRequested(state, event);
        case 'identity-refined':
            if (
                event.generation !== state.generation
                || !state.identity
                || event.identity.documentId !== state.identity.documentId
                || event.identity.revision.length === 0
                || state.committedRenderFence !== null
                || state.committedViewportFence !== null
            ) {
                return reject(state);
            }
            return accept({
                ...state,
                identity: {...event.identity},
                renderFence: null,
            });
        case 'metadata-ready':
            return metadataReady(state, event);
        case 'navigation-requested':
            return navigationRequested(state, event);
        case 'render-started':
            if (!fenceTargetsCurrentIntent(state, event.fence)) {
                return reject(state);
            }
            return accept({
                ...state,
                renderFence: event.fence,
            });
        case 'canvas-committed':
        case 'viewport-committed':
            return reduceCommit(state, event);
        case 'skeleton-delay-elapsed': {
            const delay = state.skeletonDelay;
            if (!delay || delay.generation !== event.generation || delay.token !== event.token) {
                return reject(state);
            }
            return accept({
                ...state,
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: state.requestedPage,
                    presentation: 'skeleton',
                    frameKey: null,
                    error: null,
                },
                skeletonDelay: null,
            });
        }
        case 'page-failed':
            if (!state.renderFence || !renderFenceMatches(state.renderFence, event.fence)) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'failed',
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: event.fence.pageNumber,
                    presentation: 'error',
                    frameKey: null,
                    error: event.error,
                },
                skeletonDelay: null,
                failure: event.error,
            }, state.skeletonDelay ? [{
                type: 'cancel-skeleton-delay',
                token: state.skeletonDelay.token,
            }] : []);
        case 'page-transition-failed':
            if (
                event.generation !== state.generation
                || event.pageNumber !== state.requestedPage
                || event.viewportIntentId !== state.viewportIntent?.id
                || state.lifecycle === 'ready'
                || state.lifecycle === 'empty'
                || state.lifecycle === 'closing'
            ) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'failed',
                visual: {
                    kind: 'page',
                    generation: state.generation,
                    pageNumber: event.pageNumber,
                    presentation: 'error',
                    frameKey: null,
                    error: event.error,
                },
                renderFence: null,
                skeletonDelay: null,
                failure: event.error,
            }, state.skeletonDelay ? [{
                type: 'cancel-skeleton-delay',
                token: state.skeletonDelay.token,
            }] : []);
        case 'open-failed':
            if (event.generation !== state.generation || !state.identity) {
                return reject(state);
            }
            return accept({
                ...state,
                lifecycle: 'failed',
                visual: {
                    kind: 'failed',
                    generation: state.generation,
                    error: event.error,
                },
                renderFence: null,
                skeletonDelay: null,
                failure: event.error,
            });
        case 'close-requested': {
            if (state.lifecycle === 'empty' || state.lifecycle === 'closing') {
                return reject(state);
            }
            const effects: TDocumentViewportSessionEffect[] = [];
            if (state.skeletonDelay) effects.push({
                type: 'cancel-skeleton-delay',
                token: state.skeletonDelay.token,
            });
            return accept({
                ...state,
                lifecycle: 'closing',
                renderFence: null,
                skeletonDelay: null,
            }, effects);
        }
        case 'close-committed':
            if (state.lifecycle !== 'closing' || event.generation !== state.generation) {
                return reject(state);
            }
            return accept(createEmptyDocumentViewportSession(state.generation));
        default: {
            const exhaustive: never = event;
            return exhaustive;
        }
    }
}
