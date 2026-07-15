import type { IDocumentViewportSessionState } from '@app/utils/document-viewer/session/documentViewportSession.types';

function isPositivePage(value: number) {
    return Number.isSafeInteger(value) && value >= 1;
}

export function canOpenRecentDocument(state: IDocumentViewportSessionState) {
    return state.lifecycle === 'empty' && state.identity === null && state.visual.kind === 'empty';
}

export function collectDocumentViewportSessionInvariantViolations(
    state: IDocumentViewportSessionState,
) {
    const violations: string[] = [];
    const add = (condition: boolean, message: string) => {
        if (!condition) violations.push(message);
    };

    add(Number.isSafeInteger(state.generation) && state.generation >= 0, 'generation must be non-negative');
    add(isPositivePage(state.requestedPage), 'requestedPage must be positive');
    add(state.committedPage === null || isPositivePage(state.committedPage), 'committedPage must be positive');
    add(state.observedPage === null || isPositivePage(state.observedPage), 'observedPage must be positive');
    add(state.pageCount === null || isPositivePage(state.pageCount), 'pageCount must be positive');
    if (state.pageCount !== null) {
        add(state.requestedPage <= state.pageCount, 'requestedPage must be clamped after metadata');
        add(state.committedPage === null || state.committedPage <= state.pageCount, 'committedPage exceeds pageCount');
        add(state.observedPage === null || state.observedPage <= state.pageCount, 'observedPage exceeds pageCount');
    }

    if (state.lifecycle === 'empty') {
        add(state.identity === null, 'empty session cannot have identity');
        add(state.visual.kind === 'empty', 'empty session must have the empty visual owner');
        add(state.viewportIntent === null, 'empty session cannot have viewport intent');
        add(state.renderFence === null, 'empty session cannot have render fence');
        add(state.stagedRenderFence === null, 'empty session cannot have staged render fence');
        add(state.stagedViewportFence === null, 'empty session cannot have staged viewport fence');
        add(state.skeletonDelay === null, 'empty session cannot have skeleton delay');
        add(state.observedPage === null, 'empty session cannot have observed page');
    } else {
        add(state.identity !== null, 'non-empty session must have identity');
        add(state.visual.kind !== 'empty', 'non-empty session must have a visual owner');
    }

    if (state.visual.kind !== 'empty') {
        add(state.visual.generation === state.generation, 'visual owner generation is stale');
    }
    if (state.visual.kind === 'page') {
        add(isPositivePage(state.visual.pageNumber), 'page visual must own a positive page');
        add(state.visual.presentation === 'error' || state.visual.error === null, 'non-error page visual has error');
        add(state.visual.presentation !== 'error' || state.visual.error !== null, 'error page visual lacks error');
    }
    if (state.identity && state.viewportIntent) {
        add(state.viewportIntent.generation === state.generation, 'viewport intent generation is stale');
        add(state.viewportIntent.pageNumber === state.requestedPage, 'viewport intent must target requestedPage');
    }
    for (const fence of [
        state.renderFence,
        state.stagedRenderFence,
        state.committedRenderFence,
    ]) {
        if (!fence || !state.identity) continue;
        add(fence.generation === state.generation, 'render fence generation is stale');
        add(fence.revision === state.identity.revision, 'render fence revision is stale');
    }
    if (state.stagedViewportFence && state.identity) {
        add(state.stagedViewportFence.generation === state.generation, 'staged viewport fence generation is stale');
        add(state.stagedViewportFence.revision === state.identity.revision, 'staged viewport fence revision is stale');
    }
    if (state.committedViewportFence && state.identity) {
        add(state.committedViewportFence.generation === state.generation, 'viewport fence generation is stale');
        add(state.committedViewportFence.revision === state.identity.revision, 'viewport fence revision is stale');
    }
    if (state.skeletonDelay) {
        add(state.skeletonDelay.generation === state.generation, 'skeleton delay generation is stale');
        add(
            state.visual.kind === 'page' && state.visual.presentation !== 'canvas',
            'skeleton delay requires a not-ready page visual',
        );
        add(state.skeletonDelay.pageNumber === state.requestedPage, 'skeleton delay page is stale');
    }
    if (state.lifecycle === 'ready') {
        add(state.visual.kind === 'page' && state.visual.presentation === 'canvas', 'ready session must own canvas');
        add(state.committedPage !== null, 'ready session must have committed page');
        add(state.committedRenderFence?.pageNumber === state.committedPage, 'ready render fence page mismatch');
        add(state.committedViewportFence?.pageNumber === state.committedPage, 'ready viewport fence page mismatch');
    }
    if (state.lifecycle !== 'ready') {
        add(state.observedPage === null, 'only a ready session can own an observed page');
    }
    return violations;
}

export function assertDocumentViewportSessionInvariants(state: IDocumentViewportSessionState) {
    const violations = collectDocumentViewportSessionInvariantViolations(state);
    if (violations.length > 0) {
        throw new Error(`Invalid document viewport session: ${violations.join('; ')}`);
    }
    return state;
}
