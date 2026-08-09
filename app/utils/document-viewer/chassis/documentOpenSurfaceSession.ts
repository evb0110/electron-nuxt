import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { Ref } from 'vue';
import {
    createEmptyDocumentViewportSession,
    reduceDocumentViewportSession,
    resolveDocumentViewportCurrentPage,
    type IDocumentViewportSessionState,
    type TDocumentViewportSessionEffect,
    type TDocumentViewportSessionEvent,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceReducer';

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
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceReducer';
export {
    assertDocumentViewportSessionInvariants,
    canOpenRecentDocument,
    collectDocumentViewportSessionInvariantViolations,
    createEmptyDocumentViewportSession,
    reduceDocumentViewportSession,
    resolveDocumentViewportCurrentPage,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceReducer';

export type TDocumentOpenSurfacePhase = 'idle' | 'pending' | 'geometry-committed'
    | 'canvas-committed' | 'viewport-committed' | 'ready' | 'failed';


export type TDocumentOpenSurfacePresentation = 'idle' | 'page-shell'
    | 'committed' | 'failed';
export interface IDocumentOpenSurfaceIdentity {
    readonly documentId: string;
    readonly documentRevision: string;
}

export interface IDocumentOpenSurfaceGeometry {
    readonly width: number;
    readonly height: number;
    readonly margin: number;
}

export interface IDocumentOpenSurfacePageFrame {
    readonly generation: number;
    readonly ownerId: string;
    readonly pageNumber: number;
    readonly intentKey: string;
    readonly style: Readonly<Record<string, string>>;
}

export interface IDocumentOpenSurfacePreparedPageFrame {
    readonly documentId: string;
    readonly ownerId: string;
    readonly pageNumber: number;
    readonly intentKey: string;
    readonly layoutKey: string;
    readonly policyKey: string;
    readonly sourceRevisionKey: string | null;
    readonly style: Readonly<Record<string, string>>;
    readonly geometry: IDocumentOpenSurfacePageGeometry;
}

export interface IDocumentOpenSurfacePageGeometry {
    readonly documentId: string;
    readonly pageNumber: number;
    readonly pageCount: number;
    readonly width: number;
    readonly height: number;
    readonly rotation: number;
    readonly size?: number;
    readonly modifiedAt?: number;
}

export interface IDocumentOpenSurfacePageGeometrySeed extends IDocumentOpenSurfacePageGeometry {
    readonly size: number;
    readonly modifiedAt: number;
}

export interface IDocumentOpenSurfaceRenderFence {
    readonly generation: number;
    readonly documentRevision: string;
    readonly viewportIntentId: string;
    readonly renderVersion: number;
    readonly requestId: number;
    readonly pageNumber: number;
}

export interface IDocumentOpenSurfaceRenderOwner {readonly renderVersion: number;}

export interface IDocumentOpenSurfaceViewportCommit {
    readonly generation: number;
    readonly documentRevision: string;
    readonly viewportIntentId: string;
    readonly documentGeometryRevision: number;
    readonly interactionEpoch: number;
    readonly pageNumber: number;
    readonly left: number;
    readonly top: number;
}

export interface IDocumentOpenSurfaceSnapshot {
    readonly generation: number;
    readonly identity: IDocumentOpenSurfaceIdentity | null;
    readonly phase: TDocumentOpenSurfacePhase;
    readonly presentation: TDocumentOpenSurfacePresentation;
    readonly geometry: IDocumentOpenSurfaceGeometry | null;
    readonly openingPageGeometry: IDocumentOpenSurfacePageGeometry | null;
    readonly openingPageFrame: IDocumentOpenSurfacePageFrame | null;
    readonly committedRender: IDocumentOpenSurfaceRenderFence | null;
    readonly committedViewport: IDocumentOpenSurfaceViewportCommit | null;
    readonly failure: string | null;
}

export interface IDocumentOpenSurfaceSession {
    readonly snapshot: Readonly<Ref<IDocumentOpenSurfaceSnapshot>>;
    readonly viewportSession: Readonly<Ref<IDocumentViewportSessionState>>;
    begin(
        identity: IDocumentOpenSurfaceIdentity,
        openingPageGeometry?: IDocumentOpenSurfacePageGeometry | null,
        initialPage?: number,
    ): number;
    beginPrepared(
        identity: IDocumentOpenSurfaceIdentity,
        preparedFrame: IDocumentOpenSurfacePreparedPageFrame,
    ): number | null;
    commitOpeningPageGeometry(
        generation: number,
        geometry: IDocumentOpenSurfacePageGeometry,
    ): boolean;
    claim(identity: IDocumentOpenSurfaceIdentity): number;
    supersede(): number | null;
    commitOpeningPageFrame(generation: number, frame: IDocumentOpenSurfacePageFrame): boolean;
    clearOpeningPageFrame(generation: number, ownerId: string): boolean;
    commitGeometry(generation: number, geometry: IDocumentOpenSurfaceGeometry): boolean;
    claimRenderOwner(): IDocumentOpenSurfaceRenderOwner;
    createRenderFence(
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId'>,
    ): IDocumentOpenSurfaceRenderFence | null;
    createOwnedRenderFence(
        owner: IDocumentOpenSurfaceRenderOwner,
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId' | 'renderVersion' | 'requestId'> & {
            readonly rendererVersion: number;
            readonly rendererRequestId: number;
        },
    ): IDocumentOpenSurfaceRenderFence | null;
    createOwnedResidentRenderFence(
        owner: IDocumentOpenSurfaceRenderOwner,
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId' | 'renderVersion' | 'requestId'>,
    ): IDocumentOpenSurfaceRenderFence | null;
    commitCanvas(fence: IDocumentOpenSurfaceRenderFence): boolean;
    commitViewport(commit: IDocumentOpenSurfaceViewportCommit): boolean;
    markReady(fence: IDocumentOpenSurfaceRenderFence): boolean;
    reject(fence: IDocumentOpenSurfaceRenderFence, reason: string): boolean;
    failPageTransition(pageNumber: number, reason: string): boolean;
    fail(generation: number, reason: string): boolean;
    reset(): void;
    metadataReady(pageCount: number): boolean;
    invalidateResidentVisual(pageNumber: number): boolean;
    requestNavigation(pageNumber: number, skeletonDelayMs?: number): number;
    observeViewportPage(pageNumber: number, options?: {supersedeNavigation?: boolean}): number;
}

export function resolveDocumentOpenSurfaceViewportPolicy(snapshot: IDocumentOpenSurfaceSnapshot) {
    const isTransitioning = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    return {
        overflow: isTransitioning ? 'hidden' : 'auto',
        scrollbarGutter: 'stable both-edges',
        committedMargin: snapshot.geometry?.margin ?? null,
    } as const;
}

/**
 * Scroll position is a projection of an already-committed viewport, never an
 * alternate command channel while an open or navigation intent is pending.
 * Feature packs use this fence before translating layout/scroll events back
 * into page changes. This prevents provisional tracks and restored DOM scroll
 * offsets from superseding the page owned by the viewport session.
 */
export function shouldProjectDocumentViewportScroll(
    snapshot: IDocumentOpenSurfaceSnapshot,
    viewportSession: IDocumentViewportSessionState,
) {
    return snapshot.phase === 'ready'
        && snapshot.presentation === 'committed'
        && viewportSession.lifecycle === 'ready'
        && viewportSession.committedPage !== null
        && viewportSession.requestedPage === viewportSession.committedPage;
}

export interface IDocumentViewportPositionProjection {
    readonly geometryRevision: number;
    readonly interactionEpoch: number;
    readonly left: number;
    readonly page: number;
    readonly top: number;
}

export function shouldProjectDocumentViewportCommitPage(
    surface: IDocumentOpenSurfaceSession,
    commit: IDocumentViewportPositionProjection,
) {
    const viewport = surface.viewportSession.value;
    return viewport.requestedPage === commit.page
        && resolveDocumentViewportCurrentPage(viewport) === commit.page;
}

/**
 * Commits a feature-local viewport position against the shared surface's
 * exact live navigation intent. Feature-local intent ids never cross this
 * boundary, so a late position cannot be relabelled as a newer command.
 */
export function commitDocumentOpenSurfaceViewport(
    surface: IDocumentOpenSurfaceSession,
    commit: IDocumentViewportPositionProjection,
) {
    const snapshot = surface.snapshot.value;
    const viewport = surface.viewportSession.value;
    const intent = viewport.viewportIntent;
    if (
        snapshot.identity === null
        || intent === null
        || intent.generation !== viewport.generation
        || viewport.requestedPage !== commit.page
        || intent.pageNumber !== commit.page
    ) {
        return false;
    }
    return surface.commitViewport({
        generation: snapshot.generation,
        documentRevision: snapshot.identity.documentRevision,
        viewportIntentId: intent.id,
        documentGeometryRevision: commit.geometryRevision,
        interactionEpoch: commit.interactionEpoch,
        pageNumber: commit.page,
        left: commit.left,
        top: commit.top,
    });
}

type TDocumentOpenSurfaceVisualPresentation = Exclude<TDocumentOpenSurfacePresentation, 'failed'>;

interface IDocumentOpenSurfaceVisualState {
    presentation: TDocumentOpenSurfaceVisualPresentation;
    geometry: IDocumentOpenSurfaceGeometry | null;
    openingPageGeometry: IDocumentOpenSurfacePageGeometry | null;
    openingPageFrame: IDocumentOpenSurfacePageFrame | null;
    committedViewportPosition: {
        readonly viewportIntentId: string;
        readonly left: number;
        readonly top: number;
    } | null;
}

const idleVisualState = (): IDocumentOpenSurfaceVisualState => ({
    presentation: 'idle',
    geometry: null,
    openingPageGeometry: null,
    openingPageFrame: null,
    committedViewportPosition: null,
});

function isFinitePositive(value: number) {
    return Number.isFinite(value) && value > 0;
}

function normalizeOpeningPageGeometry(
    geometry: IDocumentOpenSurfacePageGeometry | null | undefined,
) {
    if (
        !geometry
        || geometry.documentId.length === 0
        || !Number.isSafeInteger(geometry.pageNumber) || geometry.pageNumber < 1
        || !Number.isSafeInteger(geometry.pageCount) || geometry.pageCount < geometry.pageNumber
        || !isFinitePositive(geometry.width)
        || !isFinitePositive(geometry.height)
        || ![
            0,
            90,
            180,
            270,
        ].includes(geometry.rotation)
    ) {
        return null;
    }
    return Object.freeze({...geometry});
}

function fencesMatch(left: IDocumentOpenSurfaceRenderFence, right: IDocumentOpenSurfaceRenderFence) {
    return left.generation === right.generation
        && left.documentRevision === right.documentRevision
        && left.viewportIntentId === right.viewportIntentId
        && left.renderVersion === right.renderVersion
        && left.requestId === right.requestId
        && left.pageNumber === right.pageNumber;
}

function viewportRenderFenceMatches(
    fence: IDocumentOpenSurfaceRenderFence,
    viewportFence: IDocumentViewportSessionState['renderFence'],
) {
    return viewportFence !== null
        && viewportFence.revision === fence.documentRevision
        && viewportFence.viewportIntentId === fence.viewportIntentId
        && viewportFence.renderVersion === fence.renderVersion
        && viewportFence.requestId === fence.requestId
        && viewportFence.pageNumber === fence.pageNumber;
}

function isTransitionPhase(phase: TDocumentOpenSurfacePhase) {
    return phase === 'pending'
        || phase === 'geometry-committed'
        || phase === 'canvas-committed'
        || phase === 'viewport-committed';
}

export function hasCommittedDocumentOpeningLayout(snapshot: IDocumentOpenSurfaceSnapshot) {
    return isTransitionPhase(snapshot.phase)
        && snapshot.openingPageGeometry !== null
        && snapshot.openingPageFrame !== null
        && snapshot.openingPageFrame.generation === snapshot.generation
        && snapshot.openingPageFrame.pageNumber === snapshot.openingPageGeometry.pageNumber;
}

function resolveOpeningPresentation(
    snapshot: IDocumentOpenSurfaceSnapshot,
): TDocumentOpenSurfaceVisualPresentation {
    const hasMeasuredOwnedFrame = isTransitionPhase(snapshot.phase)
        && snapshot.geometry !== null
        && snapshot.openingPageFrame?.generation === snapshot.generation;
    if (hasCommittedDocumentOpeningLayout(snapshot) || hasMeasuredOwnedFrame) {
        return 'page-shell';
    }
    return snapshot.presentation === 'failed' ? 'idle' : snapshot.presentation;
}

export function isDocumentOpenEmptySurfaceTransition(snapshot: IDocumentOpenSurfaceSnapshot) {
    return isTransitionPhase(snapshot.phase);
}

export function shouldPresentDocumentOpenEmptyPlaceholder(snapshot: IDocumentOpenSurfaceSnapshot) {
    return snapshot.presentation === 'idle';
}

function canAcceptSameGenerationVisualCommit(snapshot: IDocumentOpenSurfaceSnapshot) {
    return isTransitionPhase(snapshot.phase) || snapshot.phase === 'failed';
}

function projectDocumentOpenSurfaceSnapshot(
    visual: IDocumentOpenSurfaceVisualState,
    viewport: IDocumentViewportSessionState,
): IDocumentOpenSurfaceSnapshot {
    const identity = viewport.identity === null
        ? null
        : {
            documentId: viewport.identity.documentId,
            documentRevision: viewport.identity.revision,
        };
    const projectedRenderFence = viewport.stagedRenderFence ?? viewport.committedRenderFence;
    const committedRender = projectedRenderFence === null
        ? null
        : {
            generation: viewport.generation,
            documentRevision: projectedRenderFence.revision,
            viewportIntentId: projectedRenderFence.viewportIntentId,
            renderVersion: projectedRenderFence.renderVersion,
            requestId: projectedRenderFence.requestId,
            pageNumber: projectedRenderFence.pageNumber,
        };
    const viewportFence = viewport.stagedViewportFence ?? viewport.committedViewportFence;
    const position = visual.committedViewportPosition;
    const committedViewport = viewportFence !== null
        && position?.viewportIntentId === viewportFence.viewportIntentId
        ? {
            generation: viewport.generation,
            documentRevision: viewportFence.revision,
            viewportIntentId: viewportFence.viewportIntentId,
            documentGeometryRevision: viewportFence.geometryRevision,
            interactionEpoch: viewportFence.interactionEpoch,
            pageNumber: viewportFence.pageNumber,
            left: position.left,
            top: position.top,
        }
        : null;
    const phase: TDocumentOpenSurfacePhase = viewport.lifecycle === 'empty'
        ? 'idle'
        : viewport.lifecycle === 'failed'
            ? 'failed'
            : visual.presentation === 'committed'
                ? 'ready'
                : committedRender !== null && committedViewport !== null
                    ? 'viewport-committed'
                    : committedRender !== null
                        ? 'canvas-committed'
                        : visual.geometry !== null
                            ? 'geometry-committed'
                            : 'pending';
    const presentation: TDocumentOpenSurfacePresentation = phase === 'idle'
        ? 'idle'
        : phase === 'failed'
            ? 'failed'
            : visual.presentation;
    return {
        generation: viewport.generation,
        identity,
        phase,
        presentation,
        geometry: visual.geometry,
        openingPageGeometry: visual.openingPageGeometry,
        openingPageFrame: visual.openingPageFrame,
        committedRender,
        committedViewport,
        failure: viewport.failure,
    };
}

export function createDocumentOpenSurfaceSession(): IDocumentOpenSurfaceSession {
    const sessionState = shallowRef({
        viewport: createEmptyDocumentViewportSession(),
        visual: idleVisualState(),
    });
    const viewportSession = computed(() => sessionState.value.viewport);
    const snapshot = computed(() => projectDocumentOpenSurfaceSnapshot(
        sessionState.value.visual,
        sessionState.value.viewport,
    ));
    const skeletonTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let nextViewportIntent = 0;
    let nextRenderOwnerVersion = 0;
    const renderOwnerStates = new WeakMap<IDocumentOpenSurfaceRenderOwner, {
        latestRendererVersion: number;
        latestRendererRequestId: number;
        nextSurfaceRequestId: number;
    }>();
    const ownedRenderFences = new WeakMap<IDocumentOpenSurfaceRenderFence, IDocumentOpenSurfaceRenderOwner>();
    const openingSkeletonDelayMs = 120;

    function cancelSkeletonTimer(token: string) {
        const timer = skeletonTimers.get(token);
        if (timer === undefined) {
            return;
        }
        clearTimeout(timer);
        skeletonTimers.delete(token);
    }

    function applyViewportEffect(effect: TDocumentViewportSessionEffect) {
        if (effect.type === 'cancel-skeleton-delay') {
            cancelSkeletonTimer(effect.token);
            return;
        }
        cancelSkeletonTimer(effect.token);
        const timer = setTimeout(() => {
            skeletonTimers.delete(effect.token);
            dispatchViewport({
                type: 'skeleton-delay-elapsed',
                generation: effect.generation,
                token: effect.token,
            });
        }, Math.max(0, effect.deadline - Date.now()));
        skeletonTimers.set(effect.token, timer);
    }

    function transitionViewport(
        events: readonly TDocumentViewportSessionEvent[],
        updateVisual?: (
            current: IDocumentOpenSurfaceVisualState,
            viewport: IDocumentViewportSessionState,
        ) => IDocumentOpenSurfaceVisualState,
    ) {
        let viewport = sessionState.value.viewport;
        const effects: TDocumentViewportSessionEffect[] = [];
        for (const event of events) {
            const transition = reduceDocumentViewportSession(viewport, event);
            if (!transition.accepted) {
                return false;
            }
            viewport = transition.state;
            effects.push(...transition.effects);
        }
        sessionState.value = {
            viewport,
            visual: updateVisual?.(sessionState.value.visual, viewport) ?? sessionState.value.visual,
        };
        for (const effect of effects) applyViewportEffect(effect);
        return true;
    }

    function dispatchViewport(
        event: TDocumentViewportSessionEvent,
        updateVisual?: (
            current: IDocumentOpenSurfaceVisualState,
            viewport: IDocumentViewportSessionState,
        ) => IDocumentOpenSurfaceVisualState,
    ) {
        return transitionViewport([event], updateVisual);
    }

    function commitVisual(
        update: (current: IDocumentOpenSurfaceVisualState) => IDocumentOpenSurfaceVisualState,
    ) {
        sessionState.value = {
            viewport: sessionState.value.viewport,
            visual: update(sessionState.value.visual),
        };
    }

    function createViewportIntentId(prefix: string) {
        nextViewportIntent += 1;
        return `${prefix}:${String(nextViewportIntent)}`;
    }

    function beginViewportSession(
        identity: IDocumentOpenSurfaceIdentity,
        openingPageGeometry: IDocumentOpenSurfacePageGeometry | null,
        preparedFrame?: IDocumentOpenSurfacePreparedPageFrame,
        updateVisual?: (
            current: IDocumentOpenSurfaceVisualState,
            viewport: IDocumentViewportSessionState,
        ) => IDocumentOpenSurfaceVisualState,
        initialPage = openingPageGeometry?.pageNumber ?? preparedFrame?.pageNumber ?? 1,
    ) {
        const opened = dispatchViewport({
            type: 'open-requested',
            identity: {
                documentId: identity.documentId,
                revision: identity.documentRevision,
            },
            viewportIntentId: createViewportIntentId('open'),
            initialPage: Math.max(1, Math.trunc(initialPage)),
            skeletonDelay: {
                token: createViewportIntentId('skeleton'),
                deadline: Date.now() + openingSkeletonDelayMs,
            },
            ...(preparedFrame ? {preparedPage: {
                pageNumber: preparedFrame.pageNumber,
                pageCount: preparedFrame.geometry.pageCount,
                frameKey: preparedFrame.sourceRevisionKey ?? preparedFrame.intentKey,
            }} : {}),
        }, updateVisual);
        logPdfRenderTrace('viewport-session-open-requested', {
            documentId: identity.documentId,
            opened,
            requestedPage: sessionState.value.viewport.requestedPage,
        });
        return opened;
    }

    function dispatchNavigation(
        pageNumber: number,
        skeletonDelayMs: number,
        updateVisual?: (current: IDocumentOpenSurfaceVisualState) => IDocumentOpenSurfaceVisualState,
    ) {
        const intentId = createViewportIntentId('navigation');
        const token = createViewportIntentId('skeleton');
        return dispatchViewport({
            type: 'navigation-requested',
            pageNumber,
            viewportIntentId: intentId,
            ...(skeletonDelayMs > 0 ? {skeletonDelay: {
                token,
                deadline: Date.now() + skeletonDelayMs,
            }} : {}),
        }, updateVisual);
    }

    function isCurrentFence(fence: IDocumentOpenSurfaceRenderFence) {
        const current = snapshot.value;
        return current.identity !== null
            && current.generation === fence.generation
            && current.identity.documentRevision === fence.documentRevision
            && (canAcceptSameGenerationVisualCommit(current) || current.phase === 'ready');
    }

    function createRenderFence(
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId'>,
    ): IDocumentOpenSurfaceRenderFence | null {
        const current = snapshot.value;
        const viewportState = sessionState.value.viewport;
        const viewportIntentId = viewportState.viewportIntent?.id;
        if (
            current.identity === null
            || !canAcceptSameGenerationVisualCommit(current) && current.phase !== 'ready'
            || input.generation !== current.generation
            || input.documentRevision !== current.identity.documentRevision
            || viewportIntentId === undefined
        ) {
            return null;
        }
        const fence = Object.freeze({
            ...input,
            viewportIntentId,
        });
        const accepted = dispatchViewport({
            type: 'render-started',
            fence: {
                generation: viewportState.generation,
                revision: input.documentRevision,
                pageNumber: input.pageNumber,
                viewportIntentId,
                renderVersion: input.renderVersion,
                requestId: input.requestId,
            },
        });
        return accepted ? fence : null;
    }

    function createRenderOwnerFence(
        owner: IDocumentOpenSurfaceRenderOwner,
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId' | 'renderVersion' | 'requestId'>,
    ) {
        const state = renderOwnerStates.get(owner);
        if (!state || owner.renderVersion !== nextRenderOwnerVersion) {
            return null;
        }
        state.nextSurfaceRequestId += 1;
        const fence = createRenderFence({
            ...input,
            renderVersion: owner.renderVersion,
            requestId: state.nextSurfaceRequestId,
        });
        if (fence) {
            ownedRenderFences.set(fence, owner);
        }
        return fence;
    }

    function shouldRetargetOwnedOpeningPageShell(pageNumber: number) {
        const current = snapshot.value;
        const geometry = current.openingPageGeometry;
        const frame = current.openingPageFrame;
        if (
            !isTransitionPhase(current.phase)
            || geometry === null
            || frame === null
            || frame.generation !== current.generation
            || geometry.pageNumber === pageNumber
        ) {
            return false;
        }
        return true;
    }

    return {
        snapshot: readonly(snapshot),
        viewportSession,
        begin(identity, openingPageGeometry = null, initialPage) {
            const normalizedOpeningPageGeometry = normalizeOpeningPageGeometry(openingPageGeometry);
            const identityOwnedOpeningPageGeometry = normalizedOpeningPageGeometry?.documentId === identity.documentId
                ? normalizedOpeningPageGeometry
                : null;
            const normalizedInitialPage = initialPage === undefined
                ? identityOwnedOpeningPageGeometry?.pageNumber ?? 1
                : Math.max(1, Math.trunc(initialPage));
            const ownedOpeningPageGeometry = (
                identityOwnedOpeningPageGeometry?.pageNumber === normalizedInitialPage
            )
                ? identityOwnedOpeningPageGeometry
                : null;
            beginViewportSession(identity, ownedOpeningPageGeometry, undefined, () => ({
                // The transaction phase transfers center-surface ownership away
                // from the empty placeholder immediately. Presentation remains
                // idle until real page geometry can establish the page shell.
                presentation: 'idle',
                geometry: null,
                openingPageGeometry: ownedOpeningPageGeometry,
                openingPageFrame: null,
                committedViewportPosition: null,
            }), normalizedInitialPage);
            return sessionState.value.viewport.generation;
        },
        beginPrepared(identity, preparedFrame) {
            const normalizedOpeningPageGeometry = normalizeOpeningPageGeometry(preparedFrame.geometry);
            if (
                identity.documentId.length === 0
                || identity.documentRevision.length === 0
                || preparedFrame.documentId !== identity.documentId
                || normalizedOpeningPageGeometry?.documentId !== identity.documentId
                || preparedFrame.pageNumber !== normalizedOpeningPageGeometry.pageNumber
                || preparedFrame.ownerId.length === 0
                || preparedFrame.intentKey.length === 0
                || preparedFrame.layoutKey.length === 0
                || preparedFrame.policyKey.length === 0
                || preparedFrame.sourceRevisionKey === null
                || preparedFrame.sourceRevisionKey.length === 0
                || Object.keys(preparedFrame.style).length === 0
            ) {
                return null;
            }
            const generation = sessionState.value.viewport.generation + 1;
            const opened = beginViewportSession(identity, normalizedOpeningPageGeometry, preparedFrame, () => ({
                presentation: 'page-shell',
                geometry: null,
                openingPageGeometry: normalizedOpeningPageGeometry,
                openingPageFrame: Object.freeze({
                    generation,
                    ownerId: preparedFrame.ownerId,
                    pageNumber: preparedFrame.pageNumber,
                    intentKey: preparedFrame.intentKey,
                    style: Object.freeze({...preparedFrame.style}),
                }),
                committedViewportPosition: null,
            }));
            return opened ? generation : null;
        },
        commitOpeningPageGeometry(generation, geometry) {
            const current = snapshot.value;
            const normalizedGeometry = normalizeOpeningPageGeometry(geometry);
            if (
                current.generation !== generation
                || current.phase !== 'pending'
                || normalizedGeometry === null
                || normalizedGeometry.documentId !== current.identity?.documentId
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'metadata-ready',
                generation: sessionState.value.viewport.generation,
                pageCount: normalizedGeometry.pageCount,
            }, visual => ({
                ...visual,
                openingPageGeometry: normalizedGeometry,
                presentation: resolveOpeningPresentation({
                    ...current,
                    openingPageGeometry: normalizedGeometry,
                }),
            }));
        },
        claim(identity) {
            const current = snapshot.value;
            if (isTransitionPhase(current.phase)) {
                const sameDocument = current.identity?.documentId === identity.documentId;
                const sameRevision = current.identity?.documentRevision === identity.documentRevision;
                if (sameDocument && sameRevision) {
                    return current.generation;
                }
                // The host establishes the visible generation with a
                // provisional open-intent revision before the feature pack
                // starts loading. Refining that same document to its canonical
                // source revision must not revoke the already-owned page shell.
                // Provisional fences remain invalid because identity matching
                // switches atomically here.
                if (
                    sameDocument
                    && current.identity?.documentRevision.startsWith('open-intent:')
                    && current.committedRender === null
                    && current.committedViewport === null
                ) {
                    const refined = dispatchViewport({
                        type: 'identity-refined',
                        generation: sessionState.value.viewport.generation,
                        identity: {
                            documentId: identity.documentId,
                            revision: identity.documentRevision,
                        },
                    });
                    return refined ? snapshot.value.generation : this.begin(identity);
                }
                return this.begin(identity);
            }
            return this.begin(identity);
        },
        supersede() {
            const current = snapshot.value;
            if (current.identity === null || current.phase === 'idle' || current.phase === 'failed') {
                return null;
            }
            const opened = beginViewportSession(current.identity, current.openingPageGeometry, undefined, () => ({
                presentation: 'idle',
                geometry: current.geometry,
                openingPageGeometry: current.openingPageGeometry,
                openingPageFrame: null,
                committedViewportPosition: null,
            }), sessionState.value.viewport.requestedPage);
            return opened ? sessionState.value.viewport.generation : null;
        },
        commitOpeningPageFrame(generation, frame) {
            const current = snapshot.value;
            if (
                current.generation !== generation
                || frame.generation !== generation
                || frame.ownerId.length === 0
                || !isTransitionPhase(current.phase)
                || !Number.isSafeInteger(frame.pageNumber)
                || frame.pageNumber < 1
                || frame.intentKey.length === 0
                || current.openingPageFrame !== null
                    && current.openingPageFrame.ownerId !== frame.ownerId
            ) {
                return false;
            }
            const next = {
                ...sessionState.value.visual,
                openingPageFrame: Object.freeze({
                    ...frame,
                    style: Object.freeze({...frame.style}),
                }),
            };
            commitVisual(() => ({
                ...next,
                presentation: resolveOpeningPresentation({
                    ...current,
                    openingPageFrame: next.openingPageFrame,
                }),
            }));
            return true;
        },
        clearOpeningPageFrame(generation, ownerId) {
            const current = snapshot.value;
            if (
                current.generation !== generation
                || current.openingPageFrame === null
                || current.openingPageFrame.ownerId !== ownerId
                // Ready/fail/reset own teardown. Removing the frame during an
                // empty transition would expose a blank/empty surface.
                || isTransitionPhase(current.phase)
            ) {
                return false;
            }
            commitVisual(visual => ({
                ...visual,
                openingPageFrame: null,
            }));
            return true;
        },
        commitGeometry(generation, geometry) {
            if (
                snapshot.value.generation !== generation
                || snapshot.value.phase !== 'pending'
                || !isFinitePositive(geometry.width)
                || !isFinitePositive(geometry.height)
                || !Number.isFinite(geometry.margin)
                || geometry.margin < 0
            ) {
                return false;
            }
            commitVisual(visual => ({
                ...visual,
                presentation: snapshot.value.openingPageFrame === null
                    ? visual.presentation
                    : 'page-shell',
                geometry: Object.freeze({...geometry}),
            }));
            return true;
        },
        claimRenderOwner() {
            const owner = Object.freeze({renderVersion: ++nextRenderOwnerVersion});
            renderOwnerStates.set(owner, {
                latestRendererVersion: Number.NEGATIVE_INFINITY,
                latestRendererRequestId: Number.NEGATIVE_INFINITY,
                nextSurfaceRequestId: 0,
            });
            return owner;
        },
        createRenderFence,
        createOwnedRenderFence(owner, input) {
            const state = renderOwnerStates.get(owner);
            if (!state) {
                return null;
            }
            const isOlderRendererRequest = input.rendererVersion < state.latestRendererVersion
                || input.rendererVersion === state.latestRendererVersion
                && input.rendererRequestId < state.latestRendererRequestId;
            if (isOlderRendererRequest) {
                return null;
            }
            state.latestRendererVersion = input.rendererVersion;
            state.latestRendererRequestId = input.rendererRequestId;
            return createRenderOwnerFence(owner, {
                generation: input.generation,
                documentRevision: input.documentRevision,
                pageNumber: input.pageNumber,
            });
        },
        createOwnedResidentRenderFence: createRenderOwnerFence,
        commitCanvas(fence) {
            const current = snapshot.value;
            const isReadyNavigation = current.phase === 'ready';
            const owner = ownedRenderFences.get(fence);
            if (
                owner && owner.renderVersion !== nextRenderOwnerVersion
                || !isCurrentFence(fence)
                || !isReadyNavigation && current.geometry === null
            ) {
                return false;
            }
            const previous = current.committedRender;
            if (
                previous
                && (
                    fence.renderVersion < previous.renderVersion
                    || fence.renderVersion === previous.renderVersion && fence.requestId < previous.requestId
                )
            ) {
                return false;
            }
            const accepted = dispatchViewport({
                type: 'canvas-committed',
                fence: {
                    generation: sessionState.value.viewport.generation,
                    revision: fence.documentRevision,
                    pageNumber: fence.pageNumber,
                    viewportIntentId: fence.viewportIntentId,
                    renderVersion: fence.renderVersion,
                    requestId: fence.requestId,
                },
            });
            if (!accepted) {
                return false;
            }
            return true;
        },
        commitViewport(commit) {
            const current = snapshot.value;
            if (
                current.identity === null
                || !canAcceptSameGenerationVisualCommit(current) && current.phase !== 'ready'
                || commit.generation !== current.generation
                || commit.documentRevision !== current.identity.documentRevision
                || commit.viewportIntentId.length === 0
                || !Number.isFinite(commit.documentGeometryRevision)
                || !Number.isFinite(commit.interactionEpoch)
                || !Number.isFinite(commit.left)
                || !Number.isFinite(commit.top)
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'viewport-committed',
                fence: {
                    generation: sessionState.value.viewport.generation,
                    revision: commit.documentRevision,
                    pageNumber: commit.pageNumber,
                    viewportIntentId: commit.viewportIntentId,
                    geometryRevision: commit.documentGeometryRevision,
                    interactionEpoch: commit.interactionEpoch,
                },
            }, visual => ({
                ...visual,
                committedViewportPosition: Object.freeze({
                    viewportIntentId: commit.viewportIntentId,
                    left: commit.left,
                    top: commit.top,
                }),
            }));
        },
        markReady(fence) {
            if (snapshot.value.phase === 'ready') {
                return sessionState.value.viewport.lifecycle === 'ready'
                    && sessionState.value.viewport.committedPage === fence.pageNumber;
            }
            const committed = snapshot.value.committedRender;
            const viewport = snapshot.value.committedViewport;
            if (
                snapshot.value.phase !== 'viewport-committed'
                || !committed
                || !viewport
                || !isCurrentFence(fence)
                || !fencesMatch(committed, fence)
                || viewport.pageNumber !== fence.pageNumber
            ) {
                return false;
            }
            commitVisual(visual => ({
                ...visual,
                openingPageFrame: null,
                presentation: 'committed',
            }));
            return true;
        },
        reject(fence, reason) {
            if (!isCurrentFence(fence)) {
                return false;
            }
            const viewportState = sessionState.value.viewport;
            const rejectsCurrentViewportIntent = viewportRenderFenceMatches(fence, viewportState.renderFence)
                && viewportState.requestedPage === fence.pageNumber
                && viewportState.lifecycle !== 'ready';
            const committed = snapshot.value.committedRender;
            if (!rejectsCurrentViewportIntent && committed && !fencesMatch(committed, fence)) {
                return false;
            }
            if (!rejectsCurrentViewportIntent && viewportState.renderFence !== null) {
                return false;
            }
            if (!viewportState.renderFence) {
                return false;
            }
            return dispatchViewport({
                type: 'page-failed',
                fence: viewportState.renderFence,
                error: reason,
            }, visual => ({
                ...visual,
                openingPageFrame: null,
            }));
        },
        failPageTransition(pageNumber, reason) {
            const viewport = sessionState.value.viewport;
            const intent = viewport.viewportIntent;
            if (
                !intent
                || viewport.requestedPage !== pageNumber
                || viewport.lifecycle === 'ready'
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'page-transition-failed',
                generation: viewport.generation,
                pageNumber,
                viewportIntentId: intent.id,
                error: reason,
            });
        },
        fail(generation, reason) {
            if (
                snapshot.value.generation !== generation
                || snapshot.value.phase === 'idle'
                || snapshot.value.committedRender !== null
            ) {
                return false;
            }
            return dispatchViewport({
                type: 'open-failed',
                generation: sessionState.value.viewport.generation,
                error: reason,
            }, visual => ({
                ...visual,
                openingPageFrame: null,
            }));
        },
        reset() {
            const closingGeneration = sessionState.value.viewport.generation;
            if (!transitionViewport([
                {type: 'close-requested'},
                {
                    type: 'close-committed',
                    generation: closingGeneration,
                },
            ], () => idleVisualState())) {
                commitVisual(() => idleVisualState());
            }
        },
        metadataReady(pageCount) {
            return dispatchViewport({
                type: 'metadata-ready',
                generation: sessionState.value.viewport.generation,
                pageCount,
            });
        },
        invalidateResidentVisual(pageNumber) {
            const normalized = Math.max(1, Math.trunc(pageNumber));
            const viewport = sessionState.value.viewport;
            if (
                !Number.isSafeInteger(normalized)
                || viewport.lifecycle !== 'ready'
                || viewport.requestedPage !== normalized
                || viewport.committedPage !== normalized
                || viewport.visual.kind !== 'page'
                || viewport.visual.pageNumber !== normalized
                || viewport.visual.presentation !== 'canvas'
            ) {
                return false;
            }
            return dispatchNavigation(normalized, 0);
        },
        requestNavigation(pageNumber, skeletonDelayMs = 120) {
            const normalized = Math.max(1, Math.trunc(pageNumber));
            if (!Number.isSafeInteger(normalized)) {
                return sessionState.value.viewport.requestedPage;
            }
            if (sessionState.value.viewport.identity === null) {
                // Navigation without a document identity has no semantic
                // owner. The host begins an open session synchronously before
                // exposing page commands, so retaining this value would only
                // allow a late projection from the closed document to target
                // the next file.
                logPdfRenderTrace('viewport-session-navigation-rejected-without-owner', {pageNumber: normalized});
                return sessionState.value.viewport.requestedPage;
            }
            const current = sessionState.value.viewport;
            const semanticCurrentPage = resolveDocumentViewportCurrentPage(current);
            const retargetOpeningShell = shouldRetargetOwnedOpeningPageShell(normalized);
            if (
                current.requestedPage === normalized
                && semanticCurrentPage === normalized
                && !retargetOpeningShell
            ) {
                // Page projection and viewport commit callbacks may repeat the
                // already-authoritative semantic page. While a navigation is
                // in flight, requestedPage is the semantic page; once ready,
                // observedPage can diverge after free scrolling and an explicit
                // command back to the same requested page must mint a new intent.
                // Replacing a genuinely live intent here would invalidate the
                // render/viewport fences and let a fresh skeleton timer outlive
                // the canvas it was meant to guard.
                logPdfRenderTrace('viewport-session-navigation-already-requested', {
                    pageNumber: normalized,
                    committedPage: current.committedPage,
                    observedPage: current.observedPage,
                    visual: current.visual.kind === 'page'
                        ? current.visual.presentation
                        : current.visual.kind,
                });
                return current.requestedPage;
            }
            dispatchNavigation(normalized, skeletonDelayMs, retargetOpeningShell
                ? visual => ({
                    ...visual,
                    presentation: 'page-shell',
                    geometry: null,
                    openingPageGeometry: null,
                    openingPageFrame: null,
                    committedViewportPosition: null,
                })
                : undefined);
            logPdfRenderTrace('viewport-session-navigation-dispatched', {
                pageNumber: normalized,
                requestedPage: sessionState.value.viewport.requestedPage,
                documentId: sessionState.value.viewport.identity?.documentId ?? null,
            });
            return sessionState.value.viewport.requestedPage;
        },
        observeViewportPage(pageNumber, options = {}) {
            const current = sessionState.value.viewport;
            const normalized = Math.max(1, Math.trunc(pageNumber));
            if (!Number.isSafeInteger(normalized) || current.identity === null) {
                return resolveDocumentViewportCurrentPage(current);
            }
            const supersede = options.supersedeNavigation === true
                && current.lifecycle === 'transitioning';
            dispatchViewport({
                type: supersede ? 'navigation-superseded-by-user' : 'page-observed',
                generation: current.generation,
                pageNumber: normalized,
            }, supersede ? visual => ({
                ...visual,
                presentation: 'committed',
            }) : undefined);
            return resolveDocumentViewportCurrentPage(sessionState.value.viewport);
        },
    };
}

export const documentOpenSurfaceSessionKey = Symbol('document-open-surface-session') as InjectionKey<
    IDocumentOpenSurfaceSession
>;

export function injectDocumentOpenSurfaceSession() {
    return inject(documentOpenSurfaceSessionKey, null);
}
