import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfSemanticAnchor } from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import type { IPdfNavigationRequest } from '@app/modules/pdf-viewer/engine/viewport/createPageNavigationRequest';

export type TPdfViewportIntentKind =
    | 'navigate' | 'user-scroll' | 'wheel-page' | 'zoom' | 'fit'
    | 'view-mode' | 'resize' | 'search' | 'activation' | 'document-restore' | 'dpr';
type TPdfViewportPhase =
    | 'idle' | 'resolving' | 'awaiting-metrics' | 'awaiting-slots'
    | 'applying' | 'awaiting-visual' | 'settled' | 'cancelled';

export interface IPdfViewportIntent {
    id: string;
    kind: TPdfViewportIntentKind;
    documentRevision: number;
    geometryRevision: number;
    interactionEpoch: number;
    priority: number;
    supersessionKey: string;
    navigation?: IPdfNavigationRequest;
    anchor?: IPdfSemanticAnchor;
    zoom?: number;
    viewMode?: TPdfViewMode;
    dpr?: number;
}

interface IPdfViewportResolvedCommit {
    anchor: IPdfSemanticAnchor;
    left: number;
    top: number;
    zoom?: number;
    viewMode?: TPdfViewMode;
}

export interface IPdfViewportPositionCommit {
    intentId: string;
    documentRevision: number;
    geometryRevision: number;
    interactionEpoch: number;
    page: number;
    left: number;
    top: number;
}

interface IPdfViewportAppliedPosition {
    left: number;
    top: number;
}

interface IViewportAuthorityDependencies {
    getDocumentRevision(): number;
    getGeometryRevision(): number;
    resolve(intent: IPdfViewportIntent, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    awaitMetrics(intent: IPdfViewportIntent, signal: AbortSignal): Promise<unknown>;
    awaitSlots(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    refine?(intent: IPdfViewportIntent, commit: IPdfViewportResolvedCommit, signal: AbortSignal): Promise<IPdfViewportResolvedCommit>;
    apply(
        intent: IPdfViewportIntent,
        commit: IPdfViewportResolvedCommit,
    ): unknown;
    onPositionCommitted?(commit: IPdfViewportPositionCommit): void;
    awaitVisual(intent: IPdfViewportIntent, signal: AbortSignal): Promise<void>;
    postArrival?(request: IPdfNavigationRequest, signal: AbortSignal): Promise<void>;
    clearDemand?(intentId: string): void;
}

export function createViewportAuthority(deps: IViewportAuthorityDependencies) {
    const terminalOutcomeLimit = 128;
    const phase = ref<TPdfViewportPhase>('idle');
    const activeIntent = shallowRef<IPdfViewportIntent | null>(null);
    const committedAnchor = shallowRef<IPdfSemanticAnchor | null>(null);
    const pendingTargetPage = computed(() => {
        const target = activeIntent.value?.navigation?.target;
        return target && 'page' in target ? target.page : null;
    });
    const pendingAnchorPage = computed(() => (
        pendingTargetPage.value ?? activeIntent.value?.anchor?.page ?? null
    ));
    const currentPage = computed(() => committedAnchor.value?.page ?? 1);
    let interactionEpoch = 0;
    let controller: AbortController | null = null;
    const terminal = new Map<string, 'settled' | 'cancelled'>();

    function isCurrent(
        intent: IPdfViewportIntent,
        signal: AbortSignal,
        expectedGeometryRevision = intent.geometryRevision,
    ) {
        return !signal.aborted
            && activeIntent.value?.id === intent.id
            && intent.interactionEpoch === interactionEpoch
            && intent.documentRevision === deps.getDocumentRevision()
            && expectedGeometryRevision === deps.getGeometryRevision();
    }

    function assertCurrent(
        intent: IPdfViewportIntent,
        signal: AbortSignal,
        expectedGeometryRevision = intent.geometryRevision,
    ) {
        if (!isCurrent(intent, signal, expectedGeometryRevision)) {
            throw new DOMException('Viewport intent superseded', 'AbortError');
        }
    }

    function assertCurrentIntent(intent: IPdfViewportIntent, signal: AbortSignal) {
        if (
            signal.aborted
            || activeIntent.value?.id !== intent.id
            || intent.interactionEpoch !== interactionEpoch
            || intent.documentRevision !== deps.getDocumentRevision()
        ) {
            throw new DOMException('Viewport intent superseded', 'AbortError');
        }
    }

    function finish(intent: IPdfViewportIntent, outcome: 'settled' | 'cancelled') {
        if (terminal.has(intent.id)) {
            return;
        }
        terminal.set(intent.id, outcome);
        while (terminal.size > terminalOutcomeLimit) {
            const oldestIntentId = terminal.keys().next().value;
            if (oldestIntentId === undefined) {
                break;
            }
            terminal.delete(oldestIntentId);
        }
        deps.clearDemand?.(intent.id);
        if (activeIntent.value?.id === intent.id) {
            phase.value = outcome;
            activeIntent.value = null;
            controller = null;
        }
    }

    function cancelActive() {
        const intent = activeIntent.value;
        if (!intent) {
            return;
        }
        controller?.abort();
        finish(intent, 'cancelled');
    }

    async function submit(intent: Omit<IPdfViewportIntent, 'interactionEpoch'> & {interactionEpoch?: number}) {
        if (intent.documentRevision <= 0 || intent.geometryRevision <= 0) {
            throw new Error('Viewport intents require positive live document and geometry revisions');
        }
        cancelActive();
        const next = {
            ...intent,
            interactionEpoch: intent.interactionEpoch ?? interactionEpoch,
        };
        activeIntent.value = next;
        controller = new AbortController();
        const {signal} = controller;
        let expectedGeometryRevision = next.geometryRevision;
        try {
            phase.value = 'awaiting-metrics';
            const hydratedGeometryRevision = await deps.awaitMetrics(next, signal);
            if (typeof hydratedGeometryRevision === 'number') {
                expectedGeometryRevision = hydratedGeometryRevision;
            }
            assertCurrent(next, signal, expectedGeometryRevision);
            phase.value = 'resolving';
            let commit = await deps.resolve(next, signal);
            assertCurrent(next, signal, expectedGeometryRevision);
            phase.value = 'awaiting-slots';
            await deps.awaitSlots(next, signal);
            assertCurrentIntent(next, signal);
            expectedGeometryRevision = deps.getGeometryRevision();
            if (deps.refine) {
                commit = await deps.refine(next, commit, signal);
                assertCurrent(next, signal, expectedGeometryRevision);
            }
            phase.value = 'applying';
            const applied = deps.apply(next, commit);
            committedAnchor.value = commit.anchor;
            const appliedPosition = applied
                && typeof applied === 'object'
                && 'left' in applied
                && 'top' in applied
                && typeof applied.left === 'number'
                && typeof applied.top === 'number'
                ? applied as IPdfViewportAppliedPosition
                : commit;
            const positionCommit = Object.freeze({
                intentId: next.id,
                documentRevision: next.documentRevision,
                geometryRevision: expectedGeometryRevision,
                interactionEpoch: next.interactionEpoch,
                page: commit.anchor.page,
                left: appliedPosition.left,
                top: appliedPosition.top,
            });
            deps.onPositionCommitted?.(positionCommit);
            phase.value = 'awaiting-visual';
            await deps.awaitVisual(next, signal);
            assertCurrentIntent(next, signal);
            if (next.navigation && deps.postArrival) await deps.postArrival(next.navigation, signal);
            assertCurrentIntent(next, signal);
            finish(next, 'settled');
            return {
                outcome: 'settled' as const,
                intent: next,
                positionCommit,
            };
        } catch (error) {
            finish(next, 'cancelled');
            if (error instanceof DOMException && error.name === 'AbortError') {
                return {
                    outcome: 'cancelled' as const,
                    intent: next,
                    positionCommit: null,
                };
            }
            throw error;
        }
    }

    function observeUserScroll(anchor: IPdfSemanticAnchor) {
        interactionEpoch += 1;
        cancelActive();
        committedAnchor.value = anchor;
        activeIntent.value = null;
        phase.value = 'idle';
    }

    function commitSettledPosition(input: Omit<
        IPdfViewportPositionCommit,
        'interactionEpoch'
    > & {anchor?: IPdfSemanticAnchor | undefined}) {
        if (
            activeIntent.value !== null
            || input.documentRevision !== deps.getDocumentRevision()
            || input.geometryRevision !== deps.getGeometryRevision()
        ) {
            return null;
        }
        const {
            anchor,
            ...position
        } = input;
        const commit = Object.freeze({
            ...position,
            interactionEpoch,
        });
        if (anchor) {
            committedAnchor.value = anchor;
        }
        deps.onPositionCommitted?.(commit);
        return commit;
    }

    function suspend() { cancelActive(); }
    function resume(intent: Omit<IPdfViewportIntent, 'interactionEpoch'>) { return submit(intent); }
    function dispose() {
        cancelActive();
        activeIntent.value = null;
        controller = null;
    }

    return {
        phase: readonly(phase),
        activeIntent: readonly(activeIntent),
        committedAnchor: readonly(committedAnchor),
        pendingTargetPage,
        pendingAnchorPage,
        currentPage,
        submit,
        commitSettledPosition,
        observeUserScroll,
        suspend,
        resume,
        dispose,
        getActiveNavigationRequest: () => activeIntent.value?.navigation,
        getTerminalOutcome: (intentId: string) => terminal.get(intentId) ?? null,
    };
}
