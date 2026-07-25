import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { AnnotationEntity } from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';
import { assertAnnotationBackendSemanticConformance } from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { getPdfAnnotationIdFromStableKey } from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/parsePdfAnnotationStableKey';
import type {
    ISerializationPlan,
    TSerializationBackend,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { selectSerializationBackend } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import {
    mergeLivePdfJsAnnotationChanges,
    type IPdfLiveAnnotationChangeSummary,
} from '@app/modules/pdf-viewer/runtime/save/pdfAnnotationStorageChanges';
import type {
    INativeAppendSaveRoute,
    TNativePdfMutationSaveMode,
} from '@app/modules/pdf-viewer/runtime/save/nativePdfMutationProjectionTypes';
import type {
    IPdfViewerAnnotationSavePlan,
    IPdfViewerSaveTransactionDirtyState,
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    TPdfViewerAnnotationSaveRoute,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';

/** Everything outside the frozen plan that save routing is allowed to depend on. */
export interface IPdfSaveRouteCapabilities {
    readonly saveFlowMode: TNativePdfMutationSaveMode;
    readonly availableBackends: readonly TSerializationBackend[];
    readonly nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities | undefined;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState | undefined;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure | undefined;
    readonly liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
    readonly hasLoadedSource: boolean;
    readonly forcePdfjsMaterialize: boolean;
    readonly includeManagedShapesForLiveSource: boolean;
}

/** Annotation work every backend projector consumes, derived once from the frozen plan. */
export interface IPdfSaveCanonicalInputs {
    readonly comments: IAnnotationCommentSummary[];
    readonly pendingTexts: Map<string, string>;
    readonly pendingDeletes: IAnnotationCommentSummary[];
    readonly liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
    readonly replayableEmbeddedAnnotationIds: ReadonlySet<string>;
}

export type TNativeSaveRouteRejection =
    | 'backend-not-native-append'
    | 'save-descriptors-unavailable'
    | 'not-save-mode'
    | 'native-save-capability-unavailable'
    | 'managed-shapes-require-materialization'
    | 'no-native-mutations-projected';

export interface IPdfSaveByteRouteDecision {
    readonly route: TPdfViewerAnnotationSaveRoute;
    readonly annotationPlan: IPdfViewerAnnotationSavePlan;
    readonly canonical: IPdfSaveCanonicalInputs;
    readonly baseBytes: 'loaded-source' | 'pdfjs-materialize';
    /** Precondition: source bytes may only replace a failed materialization on the source-replay route. */
    readonly sourceFallbackAllowed: boolean;
    readonly nativeRejection: TNativeSaveRouteRejection;
}

export interface IPdfSaveNativeRouteDecision extends INativeAppendSaveRoute {
    readonly annotationPlan: IPdfViewerAnnotationSavePlan;
    readonly canonical: IPdfSaveCanonicalInputs;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure;
    /** Applied when the granted native projection carries no mutation for the planned work. */
    readonly fallback: IPdfSaveByteRouteDecision;
}

export type TPdfSaveRouteDecision = IPdfSaveNativeRouteDecision | IPdfSaveByteRouteDecision;

export function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && Boolean(comment.hasNote)
        && Boolean(normalizeMarkerRect(comment.markerRect))
        && (subtype === 'freetext' || subtype === 'typewriter');
}

function entitySummary(entity: AnnotationEntity): IAnnotationCommentSummary {
    const source = entity.identity.pdfRef || entity.identity.pdfName ? 'pdf' : 'editor';
    const id = entity.identity.elementId ?? entity.identity.pdfjsUid ?? entity.identity.pdfRef ?? entity.identity.id;
    const annotationId = entity.identity.pdfRef ?? null;
    const uid = entity.identity.pdfjsUid ?? null;
    const common = {
        appAnnotationId: entity.identity.id,
        id,
        stableKey: computeSummaryStableKey({
            id,
            pageIndex: entity.pageIndex,
            source,
            uid,
            annotationId,
            ...(entity.identity.pdfName ? {annotationName: entity.identity.pdfName} : {}),
        }),
        pageIndex: entity.pageIndex,
        pageNumber: entity.pageIndex + 1,
        author: entity.author,
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
        uid,
        annotationId,
        ...(entity.identity.pdfName ? {annotationName: entity.identity.pdfName} : {}),
        source,
    } as const;
    if (entity.kind === 'sticky-note') {
        return {
            ...common,
            text: entity.text,
            subtype: 'FreeText',
            color: entity.color,
            hasNote: true,
            markerRect: structuredClone(entity.anchor),
        };
    }
    if (entity.kind === 'text-markup') {
        return {
            ...common,
            text: entity.text,
            subtype: entity.subtype,
            color: entity.color,
            opacity: entity.opacity,
            hasNote: Boolean(entity.text),
            markerRect: structuredClone(entity.geometry[0] ?? null),
        };
    }
    return {
        ...common,
        source: 'shape',
        id: entity.geometry.id,
        stableKey: computeSummaryStableKey({
            id: entity.geometry.id,
            pageIndex: entity.pageIndex,
            source: 'shape',
        }),
        text: '',
        color: entity.geometry.color,
        hasNote: false,
        markerRect: null,
    };
}

function summarizeCanonicalLiveChanges(plan: ISerializationPlan): IPdfLiveAnnotationChangeSummary {
    const ids = new Set<string>();
    const replayableEditorNoteIds = new Set<string>();
    plan.expected.forEach((entity) => {
        [
            entity.identity.id,
            entity.identity.elementId,
            entity.identity.pdfjsUid,
            entity.identity.pdfRef,
        ].forEach((candidate) => {
            const normalized = normalizePdfJsAnnotationId(candidate);
            if (!normalized) {
                return;
            }
            ids.add(normalized);
            if (entity.kind === 'sticky-note') replayableEditorNoteIds.add(normalized);
        });
    });
    return {
        ids,
        replayableEditorNoteIds,
        hasChanges: plan.steps.length > 0,
        hasUnknownChanges: false,
        fingerprint: `frontier:${plan.frontier.epoch}:${plan.frontier.entityBaselineHash}:${Array.from(ids).sort().join(',')}`,
    };
}

/**
 * The captured frontier and the live PDF.js editor session are two observations of
 * the same save work; routing consumes their union plus whatever the caller has
 * already declared dirty but PDF.js can no longer enumerate.
 */
function resolveLiveAnnotationChanges(
    plan: ISerializationPlan,
    pdfjs: IPdfLiveAnnotationChangeSummary,
    declaredLiveChanges: boolean,
): IPdfLiveAnnotationChangeSummary {
    const merged = mergeLivePdfJsAnnotationChanges(summarizeCanonicalLiveChanges(plan), pdfjs);
    if (!declaredLiveChanges || merged.hasChanges) {
        return merged;
    }
    return {
        ...merged,
        hasChanges: true,
        hasUnknownChanges: true,
        fingerprint: `${merged.fingerprint}|declared-live-pdfjs-changes`,
    };
}

function addReplayableAnnotationId(ids: Set<string>, id: string | null | undefined) {
    const normalized = normalizePdfJsAnnotationId(id);
    if (!normalized) {
        return;
    }

    ids.add(normalized);

    const nestedEditorId = normalized.match(/^editor:\d+:(.+)$/u)?.[1];
    if (nestedEditorId && nestedEditorId !== normalized) {
        addReplayableAnnotationId(ids, nestedEditorId);
    }
}

function addEmbeddedAnnotationIdFromStableKey(ids: Set<string>, stableKey: string) {
    const normalized = normalizePdfJsAnnotationId(getPdfAnnotationIdFromStableKey(stableKey));
    if (normalized) {
        ids.add(normalized);
    }
}

function addEditorRuntimeAnnotationIdFromStableKey(ids: Set<string>, stableKey: string) {
    const trimmed = stableKey.trim();
    const match = trimmed.match(/^(?:uid|editor):\d+:(.+)$/u)
        ?? trimmed.match(/^src:editor:\d+:(.+)$/u);
    addReplayableAnnotationId(ids, match?.[1]);
}

function collectReplayableEmbeddedAnnotationIds(input: {
    pendingTexts: Map<string, string>;
    pendingDeletes: IAnnotationCommentSummary[];
    comments: IAnnotationCommentSummary[];
    liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
}) {
    const ids = new Set<string>();
    input.pendingTexts.forEach((_text, stableKey) => {
        addEmbeddedAnnotationIdFromStableKey(ids, stableKey);
        addEditorRuntimeAnnotationIdFromStableKey(ids, stableKey);
    });
    input.pendingDeletes.forEach((comment) => {
        [
            comment.appAnnotationId,
            comment.annotationId,
            comment.uid,
            comment.id,
        ].forEach(id => addReplayableAnnotationId(ids, id));
        addEmbeddedAnnotationIdFromStableKey(ids, comment.stableKey);
        addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
    });
    input.comments
        .filter(isReplayableEditorOnlyFreeTextNote)
        .forEach((comment) => {
            [
                comment.annotationId,
                comment.uid,
                comment.id,
            ].forEach(id => addReplayableAnnotationId(ids, id));
            addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
        });
    if (ids.size > 0) {
        input.liveAnnotationChanges.replayableEditorNoteIds.forEach((id) => {
            addReplayableAnnotationId(ids, id);
        });
    }
    return ids;
}

function deriveCanonicalSaveInputs(
    plan: ISerializationPlan,
    capabilities: IPdfSaveRouteCapabilities,
): IPdfSaveCanonicalInputs {
    assertAnnotationBackendSemanticConformance(plan);
    // Once a frontier has been captured, every downstream backend is projected solely
    // from that immutable plan. Reading a second live-state route here made save
    // selection depend on mutations that happened after capture.
    const comments = plan.entities
        .filter(entity => !entity.deleted)
        .map(entitySummary);
    const pendingTexts = new Map<string, string>();
    const pendingDeletes: IAnnotationCommentSummary[] = [];
    plan.expected.forEach((entity) => {
        const summary = entitySummary(entity);
        if (entity.deleted) {
            pendingDeletes.push(summary);
            return;
        }
        if (entity.kind === 'sticky-note' && (entity.identity.pdfRef || entity.identity.pdfName)) {
            pendingTexts.set(summary.stableKey, entity.text);
        }
    });
    const liveAnnotationChanges = resolveLiveAnnotationChanges(
        plan,
        capabilities.liveAnnotationChanges,
        capabilities.dirtyState?.hasLivePdfJsAnnotationChanges === true,
    );
    return {
        comments,
        pendingTexts,
        pendingDeletes,
        liveAnnotationChanges,
        replayableEmbeddedAnnotationIds: collectReplayableEmbeddedAnnotationIds({
            pendingTexts,
            pendingDeletes,
            comments,
            liveAnnotationChanges,
        }),
    };
}

function planAnnotationRoute(canonical: IPdfSaveCanonicalInputs): IPdfViewerAnnotationSavePlan {
    const live = canonical.liveAnnotationChanges;
    const hasPendingReplayableEmbeddedChanges = canonical.pendingTexts.size > 0
        || canonical.pendingDeletes.length > 0
        || canonical.replayableEmbeddedAnnotationIds.size > 0;
    const hasEditorOnlyAnnotationsPendingMaterialization = canonical.comments.some(comment =>
        comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && !isReplayableEditorOnlyFreeTextNote(comment),
    );

    if (live.hasUnknownChanges) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: 'unknown-live-pdfjs-annotation-storage',
            unreplayableLiveAnnotationIds: [],
        };
    }

    if (hasPendingReplayableEmbeddedChanges && !hasEditorOnlyAnnotationsPendingMaterialization) {
        // FreeText sticky notes are replayed by our serializer. Large scanned PDFs can
        // make PDF.js saveDocument stall, so keep replayable-only note saves off that path.
        if (!live.hasChanges) {
            return {
                route: 'source-replay',
                expectedCost: 'full-document',
                reason: 'pending-embedded-annotation-operations',
                unreplayableLiveAnnotationIds: [],
            };
        }

        const unreplayableLiveAnnotationIds = Array.from(live.ids)
            .filter(id => !canonical.replayableEmbeddedAnnotationIds.has(id));
        if (unreplayableLiveAnnotationIds.length === 0 && live.ids.size > 0) {
            return {
                route: 'source-replay',
                expectedCost: 'full-document',
                reason: 'live-pdfjs-ids-covered-by-embedded-operations',
                unreplayableLiveAnnotationIds,
            };
        }

        if (unreplayableLiveAnnotationIds.length > 0) {
            return {
                route: 'pdfjs-materialize',
                expectedCost: 'full-document',
                reason: 'unreplayable-live-pdfjs-annotation-ids',
                unreplayableLiveAnnotationIds,
            };
        }
    }

    if (live.hasChanges) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: 'live-pdfjs-annotation-storage',
            unreplayableLiveAnnotationIds: Array.from(live.ids),
        };
    }

    if (hasEditorOnlyAnnotationsPendingMaterialization) {
        return {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: 'editor-only-annotations-pending-materialization',
            unreplayableLiveAnnotationIds: [],
        };
    }

    return {
        route: 'source-clean',
        expectedCost: 'small',
        reason: 'no-live-pdfjs-annotation-work',
        unreplayableLiveAnnotationIds: [],
    };
}

interface INativeSaveDescriptors {
    readonly nativeCapabilities: IPdfViewerSaveTransactionNativeCapabilities;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure;
}

function admitNativeAppendRoute(
    plan: ISerializationPlan,
    capabilities: IPdfSaveRouteCapabilities,
): INativeSaveDescriptors | TNativeSaveRouteRejection {
    if (selectSerializationBackend(plan, capabilities.availableBackends) !== 'native-append') {
        return 'backend-not-native-append';
    }
    const {
        nativeCapabilities,
        dirtyState,
        documentStructure,
    } = capabilities;
    if (!nativeCapabilities || !dirtyState || !documentStructure) {
        return 'save-descriptors-unavailable';
    }
    if (capabilities.saveFlowMode !== 'save') {
        return 'not-save-mode';
    }
    if (!nativeCapabilities.hasNativePdfMutationCapability) {
        return 'native-save-capability-unavailable';
    }
    if (capabilities.includeManagedShapesForLiveSource) {
        return 'managed-shapes-require-materialization';
    }
    return {
        nativeCapabilities,
        dirtyState,
        documentStructure,
    };
}

/**
 * The one place save routing is decided. Every projector receives the result and
 * asserts it; none of them may re-derive a mode, capability, or coverage branch.
 */
export function classifyPdfSaveRoute(
    plan: ISerializationPlan,
    capabilities: IPdfSaveRouteCapabilities,
): TPdfSaveRouteDecision {
    const canonical = deriveCanonicalSaveInputs(plan, capabilities);
    // Forced materialization overrides the byte source but never the native-append
    // grant: bounded native mutations still beat a full PDF.js rewrite.
    const replayPlan = planAnnotationRoute(canonical);
    const annotationPlan: IPdfViewerAnnotationSavePlan = capabilities.forcePdfjsMaterialize
        ? {
            route: 'pdfjs-materialize',
            expectedCost: 'full-document',
            reason: canonical.liveAnnotationChanges.hasChanges
                ? 'live-pdfjs-annotation-baseline-diverged'
                : 'saved-pdfjs-annotation-baseline-diverged',
            unreplayableLiveAnnotationIds: Array.from(canonical.liveAnnotationChanges.ids),
        }
        : replayPlan;
    const admitted = admitNativeAppendRoute(plan, capabilities);
    const byteRoute: IPdfSaveByteRouteDecision = {
        route: annotationPlan.route,
        annotationPlan,
        canonical,
        baseBytes: capabilities.hasLoadedSource && annotationPlan.route !== 'pdfjs-materialize'
            ? 'loaded-source'
            : 'pdfjs-materialize',
        sourceFallbackAllowed: annotationPlan.route === 'source-replay',
        nativeRejection: typeof admitted === 'string' ? admitted : 'no-native-mutations-projected',
    };
    if (typeof admitted === 'string') {
        return byteRoute;
    }

    return {
        route: 'native-append',
        annotationRoute: replayPlan,
        replayableAnnotationMutationsAllowed: replayPlan.route === 'source-replay',
        metadataMutationsAllowed: admitted.nativeCapabilities.canPersistNativeMetadataMutations,
        annotationWorkDirty: admitted.dirtyState.annotationDirty
            || (admitted.dirtyState.hasAnnotationChanges && !admitted.dirtyState.shapeStateDirty),
        pdfjsMaterializeForced: capabilities.forcePdfjsMaterialize,
        annotationPlan,
        canonical,
        dirtyState: admitted.dirtyState,
        documentStructure: admitted.documentStructure,
        fallback: byteRoute,
    };
}
