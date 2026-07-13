import { createDocumentViewportSessionController } from '@app/utils/document-viewer/session/createDocumentViewportSessionController';
import { logPdfRenderTrace } from '@app/utils/pdfRenderTrace';
import type { ShallowRef } from 'vue';
import type {
    IDocumentViewportSessionState,
    TDocumentViewportSessionEffect,
} from '@app/utils/document-viewer/session/documentViewportSession';

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
    readonly viewportSession: Readonly<ShallowRef<IDocumentViewportSessionState>>;
    begin(
        identity: IDocumentOpenSurfaceIdentity,
        openingPageGeometry?: IDocumentOpenSurfacePageGeometry | null,
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
    createRenderFence(
        input: Omit<IDocumentOpenSurfaceRenderFence, 'viewportIntentId'>,
    ): IDocumentOpenSurfaceRenderFence | null;
    commitCanvas(fence: IDocumentOpenSurfaceRenderFence): boolean;
    commitViewport(commit: IDocumentOpenSurfaceViewportCommit): boolean;
    markReady(fence: IDocumentOpenSurfaceRenderFence): boolean;
    reject(fence: IDocumentOpenSurfaceRenderFence, reason: string): boolean;
    failPageTransition(pageNumber: number, reason: string): boolean;
    fail(generation: number, reason: string): boolean;
    reset(): void;
    metadataReady(pageCount: number): boolean;
    requestNavigation(pageNumber: number, skeletonDelayMs?: number): number;
    subscribeViewportEffects(
        listener: (effect: TDocumentViewportSessionEffect) => void,
    ): () => void;
}

export function resolveDocumentOpenSurfaceViewportPolicy(snapshot: IDocumentOpenSurfaceSnapshot) {
    const isTransitioning = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    return {
        overflow: isTransitioning ? 'hidden' : 'auto',
        scrollbarGutter: 'stable',
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

const idleSnapshot = (): IDocumentOpenSurfaceSnapshot => ({
    generation: 0,
    identity: null,
    phase: 'idle',
    presentation: 'idle',
    geometry: null,
    openingPageGeometry: null,
    openingPageFrame: null,
    committedRender: null,
    committedViewport: null,
    failure: null,
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

function resolveOpeningPresentation(snapshot: IDocumentOpenSurfaceSnapshot) {
    const hasMeasuredOwnedFrame = isTransitionPhase(snapshot.phase)
        && snapshot.geometry !== null
        && snapshot.openingPageFrame?.generation === snapshot.generation;
    return hasCommittedDocumentOpeningLayout(snapshot) || hasMeasuredOwnedFrame
        ? 'page-shell'
        : snapshot.presentation;
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

export function createDocumentOpenSurfaceSession(): IDocumentOpenSurfaceSession {
    const snapshot = ref<IDocumentOpenSurfaceSnapshot>(idleSnapshot());
    const viewportSessionController = createDocumentViewportSessionController();
    let nextViewportIntent = 0;
    const openingSkeletonDelayMs = 120;

    function createViewportIntentId(prefix: string) {
        nextViewportIntent += 1;
        return `${prefix}:${String(nextViewportIntent)}`;
    }

    function beginViewportSession(
        identity: IDocumentOpenSurfaceIdentity,
        openingPageGeometry: IDocumentOpenSurfacePageGeometry | null,
        preparedFrame?: IDocumentOpenSurfacePreparedPageFrame,
    ) {
        const opened = viewportSessionController.dispatch({
            type: 'open-requested',
            identity: {
                documentId: identity.documentId,
                revision: identity.documentRevision,
            },
            viewportIntentId: createViewportIntentId('open'),
            initialPage: openingPageGeometry?.pageNumber ?? preparedFrame?.pageNumber ?? 1,
            skeletonDelay: {
                token: createViewportIntentId('skeleton'),
                deadline: Date.now() + openingSkeletonDelayMs,
            },
            ...(preparedFrame ? {preparedPage: {
                pageNumber: preparedFrame.pageNumber,
                pageCount: preparedFrame.geometry.pageCount,
                frameKey: preparedFrame.sourceRevisionKey ?? preparedFrame.intentKey,
            }} : {}),
        });
        logPdfRenderTrace('viewport-session-open-requested', {
            documentId: identity.documentId,
            opened,
            requestedPage: viewportSessionController.snapshot.value.requestedPage,
        });
        return opened;
    }

    function dispatchNavigation(pageNumber: number, skeletonDelayMs: number) {
        const intentId = createViewportIntentId('navigation');
        const token = createViewportIntentId('skeleton');
        viewportSessionController.dispatch({
            type: 'navigation-requested',
            pageNumber,
            viewportIntentId: intentId,
            ...(skeletonDelayMs > 0 ? {skeletonDelay: {
                token,
                deadline: Date.now() + skeletonDelayMs,
            }} : {}),
        });
    }

    function isCurrentFence(fence: IDocumentOpenSurfaceRenderFence) {
        const current = snapshot.value;
        return current.identity !== null
            && current.generation === fence.generation
            && current.identity.documentRevision === fence.documentRevision
            && (canAcceptSameGenerationVisualCommit(current) || current.phase === 'ready');
    }

    function retargetOwnedOpeningPageShell(pageNumber: number) {
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
            return;
        }
        const next = {
            ...current,
            phase: 'pending' as const,
            presentation: 'page-shell' as const,
            geometry: null,
            openingPageGeometry: null,
            openingPageFrame: null,
            committedRender: null,
            committedViewport: null,
        };
        snapshot.value = next;
    }

    return {
        snapshot: readonly(snapshot),
        viewportSession: viewportSessionController.snapshot,
        begin(identity, openingPageGeometry = null) {
            const generation = snapshot.value.generation + 1;
            const normalizedOpeningPageGeometry = normalizeOpeningPageGeometry(openingPageGeometry);
            const ownedOpeningPageGeometry = normalizedOpeningPageGeometry?.documentId === identity.documentId
                ? normalizedOpeningPageGeometry
                : null;
            snapshot.value = {
                generation,
                identity: Object.freeze({...identity}),
                phase: 'pending',
                // The transaction phase transfers center-surface ownership away
                // from the empty placeholder immediately. Presentation remains
                // idle until real page geometry can establish the page shell.
                presentation: 'idle',
                geometry: null,
                openingPageGeometry: ownedOpeningPageGeometry,
                openingPageFrame: null,
                committedRender: null,
                committedViewport: null,
                failure: null,
            };
            beginViewportSession(identity, ownedOpeningPageGeometry);
            return generation;
        },
        beginPrepared(identity, preparedFrame) {
            const current = snapshot.value;
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
            const generation = current.generation + 1;
            snapshot.value = {
                generation,
                identity: Object.freeze({...identity}),
                phase: 'pending',
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
                committedRender: null,
                committedViewport: null,
                failure: null,
            };
            beginViewportSession(identity, normalizedOpeningPageGeometry, preparedFrame);
            return generation;
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
            const next = {
                ...current,
                openingPageGeometry: normalizedGeometry,
            };
            snapshot.value = {
                ...next,
                presentation: resolveOpeningPresentation(next),
            };
            viewportSessionController.dispatch({
                type: 'metadata-ready',
                generation: viewportSessionController.snapshot.value.generation,
                pageCount: normalizedGeometry.pageCount,
            });
            return true;
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
                    snapshot.value = {
                        ...current,
                        identity: Object.freeze({...identity}),
                    };
                    viewportSessionController.dispatch({
                        type: 'identity-refined',
                        generation: viewportSessionController.snapshot.value.generation,
                        identity: {
                            documentId: identity.documentId,
                            revision: identity.documentRevision,
                        },
                    });
                    return current.generation;
                }
                const generation = current.generation + 1;
                snapshot.value = {
                    generation,
                    identity: Object.freeze({...identity}),
                    phase: 'pending',
                    presentation: 'idle',
                    geometry: null,
                    openingPageGeometry: null,
                    openingPageFrame: null,
                    committedRender: null,
                    committedViewport: null,
                    failure: null,
                };
                beginViewportSession(identity, null);
                return generation;
            }
            return this.begin(identity);
        },
        supersede() {
            const current = snapshot.value;
            if (current.identity === null || current.phase === 'idle' || current.phase === 'failed') {
                return null;
            }
            const generation = current.generation + 1;
            snapshot.value = {
                generation,
                identity: current.identity,
                phase: 'pending',
                presentation: 'idle',
                geometry: current.geometry,
                openingPageGeometry: current.openingPageGeometry,
                openingPageFrame: null,
                committedRender: null,
                committedViewport: null,
                failure: null,
            };
            beginViewportSession(current.identity, current.openingPageGeometry);
            return generation;
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
                ...current,
                openingPageFrame: Object.freeze({
                    ...frame,
                    style: Object.freeze({...frame.style}),
                }),
            };
            snapshot.value = {
                ...next,
                presentation: resolveOpeningPresentation(next),
            };
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
            snapshot.value = {
                ...current,
                openingPageFrame: null,
            };
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
            snapshot.value = {
                ...snapshot.value,
                phase: 'geometry-committed',
                presentation: snapshot.value.openingPageFrame === null ? snapshot.value.presentation : 'page-shell',
                geometry: Object.freeze({...geometry}),
            };
            return true;
        },
        createRenderFence(input) {
            const current = snapshot.value;
            const viewportState = viewportSessionController.snapshot.value;
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
            const accepted = viewportSessionController.dispatch({
                type: 'render-started',
                fence: {
                    // Surface and viewport sessions have independent lifecycle
                    // counters (viewport close commits advance their own
                    // generation). Validate the surface generation above, then
                    // translate into the current viewport generation here.
                    generation: viewportState.generation,
                    revision: input.documentRevision,
                    pageNumber: input.pageNumber,
                    viewportIntentId,
                    renderVersion: input.renderVersion,
                    requestId: input.requestId,
                },
            });
            return accepted ? fence : null;
        },
        commitCanvas(fence) {
            const current = snapshot.value;
            const isReadyNavigation = current.phase === 'ready';
            if (!isCurrentFence(fence) || !isReadyNavigation && current.geometry === null) {
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
            const accepted = viewportSessionController.dispatch({
                type: 'canvas-committed',
                fence: {
                    generation: viewportSessionController.snapshot.value.generation,
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
            const phase = isReadyNavigation
                ? 'ready'
                : current.committedViewport?.pageNumber === fence.pageNumber
                    ? 'viewport-committed'
                    : 'canvas-committed';
            snapshot.value = {
                ...current,
                phase,
                committedRender: fence,
                failure: null,
            };
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
            const accepted = viewportSessionController.dispatch({
                type: 'viewport-committed',
                fence: {
                    generation: viewportSessionController.snapshot.value.generation,
                    revision: commit.documentRevision,
                    pageNumber: commit.pageNumber,
                    viewportIntentId: commit.viewportIntentId,
                    geometryRevision: commit.documentGeometryRevision,
                    interactionEpoch: commit.interactionEpoch,
                },
            });
            if (!accepted) {
                return false;
            }
            const phase = current.phase === 'ready'
                ? 'ready'
                : current.committedRender?.pageNumber === commit.pageNumber
                    ? 'viewport-committed'
                    : current.phase;
            snapshot.value = {
                ...current,
                phase,
                committedViewport: Object.freeze({...commit}),
                failure: null,
            };
            return true;
        },
        markReady(fence) {
            if (snapshot.value.phase === 'ready') {
                return viewportSessionController.snapshot.value.lifecycle === 'ready'
                    && viewportSessionController.snapshot.value.committedPage === fence.pageNumber;
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
            snapshot.value = {
                ...snapshot.value,
                phase: 'ready',
                presentation: 'committed',
            };
            return true;
        },
        reject(fence, reason) {
            if (!isCurrentFence(fence)) {
                return false;
            }
            const viewportState = viewportSessionController.snapshot.value;
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
            snapshot.value = {
                ...snapshot.value,
                phase: 'failed',
                presentation: 'failed',
                openingPageFrame: null,
                failure: reason,
            };
            if (viewportState.renderFence) viewportSessionController.dispatch({
                type: 'page-failed',
                fence: viewportState.renderFence,
                error: reason,
            });
            return true;
        },
        failPageTransition(pageNumber, reason) {
            const viewport = viewportSessionController.snapshot.value;
            const intent = viewport.viewportIntent;
            if (
                !intent
                || viewport.requestedPage !== pageNumber
                || viewport.lifecycle === 'ready'
            ) {
                return false;
            }
            return viewportSessionController.dispatch({
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
            snapshot.value = {
                ...snapshot.value,
                phase: 'failed',
                presentation: 'failed',
                openingPageFrame: null,
                failure: reason,
            };
            viewportSessionController.dispatch({
                type: 'open-failed',
                generation: viewportSessionController.snapshot.value.generation,
                error: reason,
            });
            return true;
        },
        reset() {
            const closingGeneration = viewportSessionController.snapshot.value.generation;
            if (viewportSessionController.dispatch({type: 'close-requested'})) {
                viewportSessionController.dispatch({
                    type: 'close-committed',
                    generation: closingGeneration,
                });
            }
            snapshot.value = {
                ...idleSnapshot(),
                generation: snapshot.value.generation,
            };
        },
        metadataReady(pageCount) {
            return viewportSessionController.dispatch({
                type: 'metadata-ready',
                generation: viewportSessionController.snapshot.value.generation,
                pageCount,
            });
        },
        requestNavigation(pageNumber, skeletonDelayMs = 120) {
            const normalized = Math.max(1, Math.trunc(pageNumber));
            if (!Number.isSafeInteger(normalized)) {
                return viewportSessionController.snapshot.value.requestedPage;
            }
            if (viewportSessionController.snapshot.value.identity === null) {
                // Navigation without a document identity has no semantic
                // owner. The host begins an open session synchronously before
                // exposing page commands, so retaining this value would only
                // allow a late projection from the closed document to target
                // the next file.
                logPdfRenderTrace('viewport-session-navigation-rejected-without-owner', {pageNumber: normalized});
                return viewportSessionController.snapshot.value.requestedPage;
            }
            const current = viewportSessionController.snapshot.value;
            if (current.requestedPage === normalized) {
                // Page projection and viewport commit callbacks may repeat the
                // already-authoritative semantic page. Replacing its intent here
                // would invalidate the in-flight render/viewport fences and let
                // a fresh skeleton timer outlive the canvas it was meant to guard.
                logPdfRenderTrace('viewport-session-navigation-already-requested', {
                    pageNumber: normalized,
                    committedPage: current.committedPage,
                    visual: current.visual.kind === 'page'
                        ? current.visual.presentation
                        : current.visual.kind,
                });
                return current.requestedPage;
            }
            dispatchNavigation(normalized, skeletonDelayMs);
            retargetOwnedOpeningPageShell(viewportSessionController.snapshot.value.requestedPage);
            logPdfRenderTrace('viewport-session-navigation-dispatched', {
                pageNumber: normalized,
                requestedPage: viewportSessionController.snapshot.value.requestedPage,
                documentId: viewportSessionController.snapshot.value.identity?.documentId ?? null,
            });
            return viewportSessionController.snapshot.value.requestedPage;
        },
        subscribeViewportEffects(listener) {
            return viewportSessionController.subscribe(listener);
        },
    };
}

export const documentOpenSurfaceSessionKey = Symbol('document-open-surface-session') as InjectionKey<
    IDocumentOpenSurfaceSession
>;

export function injectDocumentOpenSurfaceSession() {
    return inject(documentOpenSurfaceSessionKey, null);
}
