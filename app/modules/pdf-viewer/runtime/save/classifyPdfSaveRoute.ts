import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { AnnotationEntity } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { computeSummaryStableKey } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {
    assertAnnotationBackendSemanticConformance,
    projectAnnotationBackendMutations,
} from '@app/modules/pdf-viewer/annotations/persistence/annotationBackendConformance';
import {
    getPdfAnnotationIdFromStableKey,
    parsePdfAnnotationStableKeyRef,
} from '@app/modules/pdf-viewer/engine/pdf-serialization-refs/parsePdfAnnotationStableKey';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import type {
    ISerializationPlan,
    TSerializationBackend,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import { selectSerializationBackend } from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {
    normalizePdfJsAnnotationId,
    parsePdfAnnotationRef,
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
    IPdfSaveByteRouteDecision,
    IPdfSaveCanonicalInputs,
    IPdfViewerAnnotationSavePlan,
    INativePdfMutationProjection,
    IPdfViewerSaveTransactionDirtyState,
    IPdfViewerSaveTransactionDocumentStructure,
    IPdfViewerSaveTransactionNativeCapabilities,
    TNativeSaveRouteRejection,
} from '@app/modules/pdf-viewer/runtime/save/pdfViewerSaveTransaction.types';
import {
    buildNativeAnnotationDeletesForSave,
    getNativeAnnotationDeleteCommentTargetKey,
    getNativeAnnotationDeleteRequestTargetKey,
} from '@app/modules/pdf-viewer/runtime/save/buildNativeAnnotationDeletesForSave';
import {
    buildNativeFreeTextNotesForSave,
    isReplayableEditorOnlyFreeTextNote,
    isReplayableCanonicalStickyNote,
} from '@app/modules/pdf-viewer/runtime/save/nativeFreeTextNotes';
import {isReplayableCanonicalTextBox} from '@app/modules/pdf-viewer/runtime/save/nativeTextBoxMutations';
import type {IPdfNativeTextBoxMutation} from '@contracts/electronApiDocuments';
import { buildNativeMarkupMutationForSave } from '@app/modules/pdf-viewer/runtime/save/nativeMarkupMutations';
import {
    buildNativeBookmarksMutationForSave,
    buildNativePageLabelsMutationForSave,
} from '@app/modules/pdf-viewer/runtime/save/nativeMetadataMutations';
import {
    arePendingTextsCoveredByNativeChanges,
    buildNativeNoteTextUpdatesForSave,
} from '@app/modules/pdf-viewer/runtime/save/nativeNoteTextUpdates';
import {buildNativeNoteGeometryUpdatesForSave} from '@app/modules/pdf-viewer/runtime/save/buildNativeNoteGeometryUpdatesForSave';
import {buildNativeShapesMutationForSave} from '@app/modules/pdf-viewer/runtime/save/nativeShapeMutations';

export type {
    IPdfSaveByteRouteDecision,
    IPdfSaveCanonicalInputs,
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
    readonly rewriteShapeState: boolean;
    readonly totalPageCount: number;
    readonly shapes: IShapeAnnotation[] | null;
    readonly deletedEmbeddedShapeAnnotationIds: string[];
    readonly deletedEmbeddedShapeStableKeys: string[];
    readonly markupSubtypeOverrides: Map<string, TMarkupSubtype> | undefined;
    readonly markupSubtypeHints: IMarkupSubtypeHint[];
    /** `undefined` preserves the pre-canonical-text-box compatibility path. */
    readonly nativeTextBoxes?: IPdfNativeTextBoxMutation[] | null;
}

export interface IPdfSaveNativeRouteDecision extends INativeAppendSaveRoute {
    readonly annotationPlan: IPdfViewerAnnotationSavePlan;
    readonly canonical: IPdfSaveCanonicalInputs;
    readonly dirtyState: IPdfViewerSaveTransactionDirtyState;
    readonly documentStructure: IPdfViewerSaveTransactionDocumentStructure;
    /** Preclassified atomic alternate if native persistence cannot expose its output. */
    readonly fallback: IPdfSaveByteRouteDecision;
}

export type TPdfSaveRouteDecision = IPdfSaveNativeRouteDecision | IPdfSaveByteRouteDecision;

function entitySummary(entity: AnnotationEntity): IAnnotationCommentSummary {
    const source = entity.kind === 'shape'
        ? 'shape' as const
        : entity.persistedRevision >= 0 && entity.identity.pdfRef
            ? 'pdf' as const
            : 'editor' as const;
    const id = entity.identity.pdfRef ?? entity.identity.id;
    const annotationId = entity.identity.pdfRef ?? null;
    const common = {
        appAnnotationId: entity.identity.id,
        id,
        stableKey: computeSummaryStableKey({
            id,
            pageIndex: entity.pageIndex,
            source,
            annotationId,
        }),
        pageIndex: entity.pageIndex,
        pageNumber: entity.pageIndex + 1,
        author: entity.author,
        createdAt: entity.createdAt,
        modifiedAt: entity.modifiedAt,
        uid: null,
        annotationId,
        source,
    } as const;
    if (entity.kind === 'text-box') {
        return {
            ...common,
            text: entity.text,
            subtype: 'FreeText',
            color: entity.color,
            hasNote: Boolean(entity.text),
            markerRect: structuredClone(entity.rect),
        };
    }
    if (entity.kind === 'note') {
        return {
            ...common,
            text: entity.contents,
            subtype: 'Text',
            color: entity.color,
            hasNote: true,
            markerRect: structuredClone(entity.position),
        };
    }
    if (entity.kind === 'text-markup') {
        return {
            ...common,
            text: entity.contents,
            subtype: entity.subtype,
            color: entity.color,
            opacity: entity.opacity,
            hasNote: Boolean(entity.contents),
            markerRect: structuredClone(entity.quadPoints[0] ?? null),
            markupGeometry: structuredClone(entity.quadPoints),
        };
    }
    if (entity.kind === 'placed-image') {
        return {
            ...common,
            text: '',
            subtype: 'Stamp',
            color: null,
            hasNote: false,
            markerRect: structuredClone(entity.rect),
        };
    }
    return {
        ...common,
        source: 'shape',
        id: entity.identity.id,
        stableKey: computeSummaryStableKey({
            id: entity.identity.id,
            pageIndex: entity.pageIndex,
            source: 'shape',
        }),
        text: '',
        color: entity.strokeColor,
        hasNote: false,
        markerRect: structuredClone(entity.rect),
    };
}

/**
 * A persisted import can appear in dirtyAt while the saved semantic baseline
 * is still being rebuilt around editor work. Revision equality means it is not
 * authored work. Tombstones remain changes because page remaps can preserve
 * their revision.
 */
function isActuallyChangedEntity(entity: AnnotationEntity) {
    return entity.deleted || entity.revision !== entity.persistedRevision;
}

function isNewCanonicalStickyNoteEntity(entity: AnnotationEntity) {
    return entity.kind === 'note'
        && entity.persistedRevision < 0
        && !entity.identity.pdfRef;
}

function summarizeCanonicalLiveChanges(plan: ISerializationPlan): IPdfLiveAnnotationChangeSummary {
    const ids = new Set<string>();
    const replayableEditorNoteIds = new Set<string>();
    const changedEntities = plan.expected.filter(isActuallyChangedEntity);
    changedEntities.forEach((entity) => {
        [
            entity.identity.id,
            entity.identity.pdfRef,
        ].forEach((candidate) => {
            addReplayableAnnotationId(ids, candidate);
            if (entity.kind === 'note' || entity.kind === 'text-box') {
                addReplayableAnnotationId(replayableEditorNoteIds, candidate);
            }
        });
    });
    return {
        ids,
        replayableEditorNoteIds,
        nativeFreeTextEditors: new Map(),
        hasChanges: changedEntities.length > 0,
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
    changedComments: IAnnotationCommentSummary[];
    replayableCanonicalStickyNoteStableKeys: ReadonlySet<string>;
    liveAnnotationChanges: IPdfLiveAnnotationChangeSummary;
    nativeTextBoxes?: ReadonlyArray<Pick<IPdfNativeTextBoxMutation, 'stableKey' | 'annotationId'>>;
    shapes?: readonly IShapeAnnotation[] | null;
}) {
    const ids = new Set<string>();
    input.shapes?.forEach((shape) => {
        // Managed shapes are written by the structured native shape payload.
        // Their PDF.js aliases must not force the whole save onto materialization.
        addReplayableAnnotationId(ids, shape.annotationId);
        addReplayableAnnotationId(ids, shape.stableKey);
    });
    input.nativeTextBoxes?.forEach((textBox) => {
        // An imported FreeText can appear in PDF.js storage under both the
        // canonical /NM and its indirect PDF object ref. The native payload
        // owns both identities, so neither should force materialization.
        addReplayableAnnotationId(ids, textBox.stableKey);
        addReplayableAnnotationId(ids, textBox.annotationId);
    });
    input.pendingTexts.forEach((_text, stableKey) => {
        addEmbeddedAnnotationIdFromStableKey(ids, stableKey);
        addEditorRuntimeAnnotationIdFromStableKey(ids, stableKey);
        const matchingComments = input.comments.filter(candidate => candidate.stableKey === stableKey);
        if (matchingComments.length === 1) {
            addCommentIdentityAliases(ids, matchingComments[0]!);
        }
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
        .filter(comment => isReplayableEditorOnlyFreeTextNote(comment) || isReplayableCanonicalTextBox(comment))
        .forEach((comment) => {
            [
                comment.annotationId,
                comment.uid,
                comment.id,
            ].forEach(id => addReplayableAnnotationId(ids, id));
            addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
        });
    input.changedComments
        .filter(comment => comment.source === 'shape')
        .forEach((comment) => {
            // Canonical shapes are projected by the native shape mutation
            // payload. Their canonical aliases must not make that payload look
            // like unrelated PDF.js work.
            addCommentIdentityAliases(ids, comment);
        });
    input.changedComments
        .filter(comment => (
            isReplayableCanonicalStickyNote(comment)
            && input.replayableCanonicalStickyNoteStableKeys.has(comment.stableKey)
        ))
        .forEach((comment) => {
            addCommentIdentityAliases(ids, comment);
        });
    input.liveAnnotationChanges.nativeFreeTextEditors.forEach((_editor, id) => {
        addReplayableAnnotationId(ids, id);
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
    const changedEntities = plan.expected
        .filter(entity => !entity.deleted && isActuallyChangedEntity(entity));
    const changedComments = plan.expected
        .filter(entity => !entity.deleted && isActuallyChangedEntity(entity))
        .map(entitySummary);
    const pendingTexts = new Map<string, string>();
    const pendingDeletes: IAnnotationCommentSummary[] = [];
    plan.expected.filter(isActuallyChangedEntity).forEach((entity) => {
        const summary = entitySummary(entity);
        if (entity.deleted && entity.kind !== 'shape') {
            pendingDeletes.push(summary);
            return;
        }
        if (
            (entity.kind === 'note' || (entity.kind === 'text-box' && capabilities.nativeTextBoxes === undefined))
            && entity.identity.pdfRef
        ) {
            pendingTexts.set(summary.stableKey, summary.text);
        }
    });
    const liveAnnotationChanges = resolveLiveAnnotationChanges(
        plan,
        capabilities.liveAnnotationChanges,
        capabilities.dirtyState?.hasLivePdfJsAnnotationChanges === true,
    );
    const replayableCanonicalStickyNoteStableKeys = new Set(
        changedEntities
            .filter(isNewCanonicalStickyNoteEntity)
            .map(entity => entitySummary(entity).stableKey),
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
            changedComments,
            replayableCanonicalStickyNoteStableKeys,
            liveAnnotationChanges,
            ...(capabilities.nativeTextBoxes === undefined
                ? {}
                : {nativeTextBoxes: capabilities.nativeTextBoxes ?? []}),
            shapes: capabilities.shapes,
        }),
        replayableCanonicalStickyNoteStableKeys,
    };
}

function planAnnotationRoute(canonical: IPdfSaveCanonicalInputs): IPdfViewerAnnotationSavePlan {
    const live = canonical.liveAnnotationChanges;
    const hasPendingReplayableEmbeddedChanges = canonical.pendingTexts.size > 0
        || canonical.pendingDeletes.length > 0
        || canonical.replayableEmbeddedAnnotationIds.size > 0;
    const hasEditorOnlyAnnotationsPendingMaterialization = canonical.comments.some(comment =>
        comment.source === 'editor'
        && !parsePdfAnnotationRef(comment.annotationId)
        && !isReplayableEditorOnlyFreeTextNote(comment)
        && !isReplayableCanonicalTextBox(comment)
        && !canonical.replayableCanonicalStickyNoteStableKeys.has(comment.stableKey),
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
 * Shapes are canonical annotation entities, so the coarse annotation revision
 * counters cannot tell shape work apart from note and markup work. The plan
 * owns what this save actually changes, so ask it instead.
 */
function hasNonShapeAnnotationWork(plan: ISerializationPlan) {
    return plan.expected.some(entity => isActuallyChangedEntity(entity) && entity.kind !== 'shape');
}

function addCommentIdentityAliases(ids: Set<string>, comment: IAnnotationCommentSummary) {
    [
        comment.appAnnotationId,
        comment.annotationId,
        comment.id,
        comment.uid,
    ].forEach(id => addReplayableAnnotationId(ids, id));
    addEmbeddedAnnotationIdFromStableKey(ids, comment.stableKey);
    addEditorRuntimeAnnotationIdFromStableKey(ids, comment.stableKey);
}

function areAnnotationIdentityAliasesEqual(
    left: string | null | undefined,
    right: string | null | undefined,
) {
    const normalizedLeft = normalizePdfJsAnnotationId(left);
    const normalizedRight = normalizePdfJsAnnotationId(right);
    return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function isTextMarkupComment(comment: IAnnotationCommentSummary) {
    return comment.subtype === 'Highlight'
        || comment.subtype === 'Underline'
        || comment.subtype === 'StrikeOut'
        || comment.subtype === 'Strikethrough'
        || comment.subtype === 'Squiggly';
}

function markupHintMatchesComment(
    hint: Pick<IMarkupSubtypeHint, 'appAnnotationId' | 'id' | 'annotationId' | 'subtype'>,
    comment: IAnnotationCommentSummary,
) {
    if (
        !isTextMarkupComment(comment)
        || (
            hint.subtype !== comment.subtype
            && !(hint.subtype === 'StrikeOut' && comment.subtype === 'Strikethrough')
        )
    ) {
        return false;
    }
    const hintIdentities = [
        hint.appAnnotationId,
        hint.id,
        hint.annotationId,
    ];
    const commentIdentities = [
        comment.appAnnotationId,
        comment.annotationId,
        comment.annotationName,
        comment.id,
        comment.uid,
    ];
    return hintIdentities.some(hintIdentity => (
        commentIdentities.some(commentIdentity => (
            areAnnotationIdentityAliasesEqual(hintIdentity, commentIdentity)
        ))
    ));
}

function markupOverrideMatchesComment(
    annotationId: string,
    comment: IAnnotationCommentSummary,
) {
    if (!isTextMarkupComment(comment)) {
        return false;
    }
    return [
        comment.appAnnotationId,
        comment.annotationId,
        comment.annotationName,
        comment.id,
        comment.uid,
    ].some(commentIdentity => (
        areAnnotationIdentityAliasesEqual(annotationId, commentIdentity)
    ));
}

function isCanonicalTextBoxComment(comment: IAnnotationCommentSummary) {
    return Boolean(comment.appAnnotationId)
        && comment.subtype?.trim().toLowerCase() === 'freetext';
}

function nativeTextBoxCoversComment(
    textBox: {
        stableKey: string;
        annotationId?: string | null
    },
    comment: IAnnotationCommentSummary,
) {
    const textBoxIdentities = [
        textBox.stableKey,
        textBox.annotationId,
    ];
    const commentIdentities = [
        comment.appAnnotationId,
        comment.annotationId,
        comment.id,
        comment.uid,
        comment.stableKey,
    ];
    return textBoxIdentities.some(textBoxIdentity => (
        commentIdentities.some(commentIdentity => (
            textBoxIdentity === commentIdentity
            || areAnnotationIdentityAliasesEqual(textBoxIdentity, commentIdentity)
        ))
    ));
}

function collectProjectedNativeAnnotationIds(input: {
    changedComments: IAnnotationCommentSummary[];
    deletedComments: readonly IAnnotationCommentSummary[];
    persistedComments: IAnnotationCommentSummary[];
    replayableEditorNoteIds: ReadonlySet<string>;
    noteTextUpdates: Array<{
        objectNumber: number;
        generationNumber: number;
    }>;
    noteGeometryUpdates: Array<{
        objectNumber: number;
        generationNumber: number;
    }>;
    freeTextNotes: Array<{ stableKey: string }>;
    nativeFreeTextEditors: ReadonlyMap<string, { stableKey: string }>;
    textBoxes: ReadonlyArray<{
        stableKey: string;
        annotationId?: string | null
    }>;
    shapes: readonly IShapeAnnotation[] | null;
    markup: {
        overrides: Array<readonly [string, TMarkupSubtype]>;
        hints: Array<Pick<IMarkupSubtypeHint, 'id' | 'annotationId' | 'subtype'>>;
    } | null;
}) {
    const ids = new Set<string>();
    const updatedRefs = new Set(input.noteTextUpdates.map(update =>
        `${update.objectNumber}R${update.generationNumber}`));
    const geometryUpdatedRefs = new Set(input.noteGeometryUpdates.map(update =>
        `${update.objectNumber}R${update.generationNumber}`));
    const freeTextStableKeys = new Set(input.freeTextNotes.map(note => note.stableKey));

    input.shapes?.forEach((shape) => {
        addReplayableAnnotationId(ids, shape.annotationId);
        addReplayableAnnotationId(ids, shape.stableKey);
    });

    input.textBoxes.forEach((textBox) => {
        addReplayableAnnotationId(ids, textBox.stableKey);
        addReplayableAnnotationId(ids, textBox.annotationId);
    });

    input.changedComments.forEach((comment) => {
        const targetRef = parsePdfAnnotationStableKeyRef(comment.stableKey)?.ref
            ?? parsePdfAnnotationRef(comment.annotationId);
        const hasProjectedTextUpdate = targetRef !== null
            && updatedRefs.has(`${targetRef.objectNumber}R${targetRef.generationNumber}`);
        const hasProjectedGeometryUpdate = targetRef !== null
            && geometryUpdatedRefs.has(`${targetRef.objectNumber}R${targetRef.generationNumber}`);
        const hasProjectedFreeTextNote = input.freeTextNotes.some(note => [
            comment.appAnnotationId,
            comment.annotationId,
            comment.id,
            comment.uid,
            comment.stableKey,
        ].some(identity => (
            identity === note.stableKey
            || areAnnotationIdentityAliasesEqual(identity, note.stableKey)
        )));
        if (
            hasProjectedTextUpdate
            || hasProjectedGeometryUpdate
            || freeTextStableKeys.has(comment.stableKey)
            || hasProjectedFreeTextNote
        ) {
            addCommentIdentityAliases(ids, comment);
        }
    });
    input.deletedComments.forEach(comment => addCommentIdentityAliases(ids, comment));
    input.nativeFreeTextEditors.forEach((editor, id) => {
        addReplayableAnnotationId(ids, id);
        addEditorRuntimeAnnotationIdFromStableKey(ids, editor.stableKey);
    });
    const persistedCommentAliases = new Set<string>();
    input.persistedComments.forEach(comment => addCommentIdentityAliases(persistedCommentAliases, comment));
    input.replayableEditorNoteIds.forEach((id) => {
        const normalized = normalizePdfJsAnnotationId(id);
        if (normalized && persistedCommentAliases.has(normalized)) {
            addReplayableAnnotationId(ids, normalized);
        }
    });

    const markup = input.markup;
    if (markup) {
        // A native markup item is an acknowledgement only when it maps to a
        // changed canonical markup comment. This keeps stale or unrelated
        // live aliases fail-closed, even when the payload carries a valid
        // hint for another annotation.
        input.changedComments.forEach((comment) => {
            const hasProjectedMarkup = markup.hints.some((hint) => {
                if (!markupHintMatchesComment(hint, comment)) {
                    return false;
                }
                return true;
            }) || markup.overrides.some(([annotationId]) => {
                if (!markupOverrideMatchesComment(annotationId, comment)) {
                    return false;
                }
                return true;
            });
            if (hasProjectedMarkup) {
                // The emitted hint may carry a stale secondary alias. Only the
                // canonical comment aliases have proved the identity mapping.
                addCommentIdentityAliases(ids, comment);
            }
        });
    }
    return ids;
}

function buildClassifiedNativeMutationProjection(
    plan: ISerializationPlan,
    canonical: IPdfSaveCanonicalInputs,
    capabilities: IPdfSaveRouteCapabilities,
    admitted: INativeSaveDescriptors,
    annotationRoute: IPdfViewerAnnotationSavePlan,
): INativePdfMutationProjection | TNativeSaveRouteRejection {
    const replayAllowed = annotationRoute.route === 'source-replay';
    const changedComments = plan.entities
        .filter(entity => !entity.deleted && isActuallyChangedEntity(entity))
        .map(entitySummary);
    const persistedComments = plan.entities
        .filter(entity => (entity.kind === 'note' || entity.kind === 'text-box')
            && !entity.deleted
            && !isActuallyChangedEntity(entity))
        .map(entitySummary);
    const noteTextUpdatesResult = replayAllowed && canonical.pendingTexts.size > 0
        ? buildNativeNoteTextUpdatesForSave({
            pendingTexts: canonical.pendingTexts,
            canonicalComments: canonical.comments,
        })
        : null;
    const canonicalStickyNotesForNativeAppend = changedComments.filter(comment => (
        isReplayableCanonicalStickyNote(comment)
        && canonical.replayableCanonicalStickyNoteStableKeys.has(comment.stableKey)
    ));
    const freeTextNotesResult = buildNativeFreeTextNotesForSave({
        // EVB-owned sticky notes remain safe native payloads when another
        // canonical annotation makes the PDF.js fallback plan materialize.
        canonicalComments: replayAllowed
            ? capabilities.nativeTextBoxes === undefined
                ? changedComments
                : changedComments.filter(comment => !isCanonicalTextBoxComment(comment))
            : canonicalStickyNotesForNativeAppend,
        replayableCanonicalStickyNoteStableKeys: canonical.replayableCanonicalStickyNoteStableKeys,
    });
    const annotationDeletesResult = replayAllowed
        ? buildNativeAnnotationDeletesForSave({pendingDeletes: canonical.pendingDeletes})
        : null;
    const noteTextUpdates = noteTextUpdatesResult?.value ?? [];
    const noteGeometryUpdatesResult = replayAllowed
        ? buildNativeNoteGeometryUpdatesForSave(changedComments)
        : null;
    if (noteGeometryUpdatesResult?.skipEvents.length) {
        return 'annotation-work-not-covered-by-native-mutations';
    }
    const noteGeometryUpdates = noteGeometryUpdatesResult?.value ?? [];
    const freeTextNotes = freeTextNotesResult?.value ?? [];
    const freeTextEditors = replayAllowed
        ? Array.from(canonical.liveAnnotationChanges.nativeFreeTextEditors.values())
        : [];
    const textBoxes = capabilities.nativeTextBoxes === undefined
        ? []
        : [
            // Native text-box mutations are already a bounded projection. They
            // remain valid when unrelated live PDF.js work selects materialization.
            ...(capabilities.nativeTextBoxes ?? []),
            ...freeTextEditors,
        ];
    if (
        capabilities.nativeTextBoxes !== undefined
        && changedComments.some(isCanonicalTextBoxComment)
        && changedComments
            .filter(isCanonicalTextBoxComment)
            .some(comment => !textBoxes.some(textBox => nativeTextBoxCoversComment(textBox, comment)))
    ) {
        return 'native-text-box-payload-unavailable';
    }
    const annotationDeletes = annotationDeletesResult?.value ?? [];
    const pendingDeleteTargetKeys = canonical.pendingDeletes
        .map(getNativeAnnotationDeleteCommentTargetKey);
    const projectedDeleteTargetKeys = annotationDeletes
        .map(getNativeAnnotationDeleteRequestTargetKey);
    const pendingDeleteTargetSet = new Set(pendingDeleteTargetKeys);
    const projectedDeleteTargetSet = new Set(projectedDeleteTargetKeys);
    const hasExactNativeDeleteCoverage = (
        pendingDeleteTargetKeys.length === annotationDeletes.length
        && pendingDeleteTargetKeys.every((key): key is string => key !== null)
        && projectedDeleteTargetKeys.every((key): key is string => key !== null)
        && pendingDeleteTargetSet.size === pendingDeleteTargetKeys.length
        && projectedDeleteTargetSet.size === projectedDeleteTargetKeys.length
        && pendingDeleteTargetKeys.every(key => projectedDeleteTargetSet.has(key))
    );
    const annotationWorkDirty = hasNonShapeAnnotationWork(plan);
    const markup = buildNativeMarkupMutationForSave({
        canonicalComments: canonical.comments,
        changedComments,
        annotationWorkDirty,
        markupSubtypeOverrides: capabilities.markupSubtypeOverrides,
        markupSubtypeHints: capabilities.markupSubtypeHints,
    });
    const hasMarkupMutations = Boolean(markup);
    const projectedNativeAnnotationIds = collectProjectedNativeAnnotationIds({
        changedComments,
        // A delete covers its canonical aliases only when every requested
        // deletion produced one exact native mutation. Partial or collapsed
        // projections stay fail-closed at the baseline guard below.
        deletedComments: hasExactNativeDeleteCoverage
            ? canonical.pendingDeletes
            : [],
        persistedComments,
        replayableEditorNoteIds: canonical.liveAnnotationChanges.replayableEditorNoteIds,
        noteTextUpdates,
        noteGeometryUpdates,
        freeTextNotes,
        textBoxes,
        shapes: capabilities.shapes,
        nativeFreeTextEditors: replayAllowed
            ? canonical.liveAnnotationChanges.nativeFreeTextEditors
            : new Map(),
        markup,
    });
    const nativeNoteMutationCount = noteTextUpdates.length
        + freeTextNotes.length
        + (capabilities.nativeTextBoxes === undefined ? freeTextEditors.length : textBoxes.length)
        + annotationDeletes.length
        + noteGeometryUpdates.length;
    const savedLiveAnnotationAliasesAreNativelyReplayable = (
        canonical.liveAnnotationChanges.hasChanges
        && !canonical.liveAnnotationChanges.hasUnknownChanges
        && projectedNativeAnnotationIds.size > 0
        && [...canonical.liveAnnotationChanges.ids].every(id =>
            projectedNativeAnnotationIds.has(id))
    );
    const liveAnnotationWorkCoveredByNativeMutations = (
        canonical.liveAnnotationChanges.hasChanges
        && !canonical.liveAnnotationChanges.hasUnknownChanges
        && canonical.liveAnnotationChanges.ids.size > 0
        && [...canonical.liveAnnotationChanges.ids].every(id =>
            projectedNativeAnnotationIds.has(id))
    );
    if (
        admitted.dirtyState.savedPdfjsAnnotationBaselineDirty
        && !savedLiveAnnotationAliasesAreNativelyReplayable
    ) {
        return 'saved-pdfjs-baseline-dirty-requires-materialization';
    }

    if (capabilities.forcePdfjsMaterialize && nativeNoteMutationCount === 0 && !hasMarkupMutations) {
        return 'pdfjs-materialize-required';
    }
    if (!arePendingTextsCoveredByNativeChanges({
        pendingTexts: canonical.pendingTexts,
        nativeNoteTextUpdates: noteTextUpdatesResult?.value ?? null,
        nativeFreeTextNotes: freeTextNotesResult?.value ?? null,
    })) {
        return 'pending-texts-not-covered-by-native-mutations';
    }
    if (canonical.pendingDeletes.length > 0 && !hasExactNativeDeleteCoverage) {
        return 'pending-deletes-not-covered-by-native-mutations';
    }
    if (
        admitted.dirtyState.hasLivePdfJsAnnotationChanges
        && !liveAnnotationWorkCoveredByNativeMutations
    ) {
        return 'live-pdfjs-annotation-work-not-covered-by-native-mutations';
    }
    if (annotationWorkDirty && nativeNoteMutationCount === 0 && !hasMarkupMutations) {
        return 'annotation-work-not-covered-by-native-mutations';
    }

    const shapes = buildNativeShapesMutationForSave({
        shapeStateDirty: admitted.dirtyState.shapeStateDirty,
        rewriteShapeState: capabilities.rewriteShapeState,
        totalPageCount: capabilities.totalPageCount,
        shapes: capabilities.shapes,
        deletedAnnotationIds: capabilities.deletedEmbeddedShapeAnnotationIds,
        deletedStableKeys: capabilities.deletedEmbeddedShapeStableKeys,
    });
    const hasShapeMutations = Boolean(shapes);
    if (admitted.dirtyState.shapeStateDirty && !hasShapeMutations) {
        return 'shape-payload-unavailable';
    }
    const pageLabels = buildNativePageLabelsMutationForSave({
        pageLabelsDirty: admitted.documentStructure.pageLabelsDirty,
        totalPageCount: capabilities.totalPageCount,
        pageLabelRanges: admitted.documentStructure.pageLabelRanges,
    });
    const bookmarks = buildNativeBookmarksMutationForSave({
        bookmarksDirty: admitted.documentStructure.bookmarksDirty,
        totalPageCount: capabilities.totalPageCount,
        bookmarkItems: admitted.documentStructure.bookmarkItems,
        untitledBookmarkLabel: admitted.documentStructure.untitledBookmarkLabel,
    });
    const hasMetadataMutations = Boolean(pageLabels) || Boolean(bookmarks);
    if (
        (admitted.documentStructure.pageLabelsDirty || admitted.documentStructure.bookmarksDirty)
        && !hasMetadataMutations
    ) {
        return 'metadata-payload-unavailable';
    }
    if (
        (hasMetadataMutations || hasShapeMutations)
        && !admitted.nativeCapabilities.canPersistNativeMetadataMutations
    ) {
        return 'native-structured-save-capability-unavailable';
    }
    if (nativeNoteMutationCount === 0 && !hasMetadataMutations && !hasShapeMutations && !hasMarkupMutations) {
        return 'no-native-mutations-projected';
    }

    return {
        canonicalAnnotationProgram: projectAnnotationBackendMutations(plan, 'native-append'),
        mutations: {
            ...(noteTextUpdates.length > 0 ? {updates: noteTextUpdates} : {}),
            ...(noteGeometryUpdates.length > 0 ? {geometryUpdates: noteGeometryUpdates} : {}),
            ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
            ...(capabilities.nativeTextBoxes === undefined
                ? freeTextEditors.length > 0 ? {freeTextEditors} : {}
                : textBoxes.length > 0 ? {textBoxes} : {}),
            ...(annotationDeletes.length > 0 ? {deletes: annotationDeletes} : {}),
            ...(pageLabels ? {pageLabels} : {}),
            ...(bookmarks ? {bookmarks} : {}),
            ...(shapes ? {shapes} : {}),
            ...(markup ? {markup} : {}),
        },
        noteTextUpdates,
        noteGeometryUpdates,
        freeTextNotes,
        freeTextEditors,
        textBoxes,
        annotationDeletes,
        hasMetadataMutations,
        hasShapeMutations,
        hasMarkupMutations,
        phase: hasMetadataMutations || hasShapeMutations || hasMarkupMutations
            ? 'persist-native-pdf-mutations'
            : annotationDeletes.length > 0
                ? 'persist-native-annotation-changes'
                : textBoxes.length > 0
                    ? 'persist-native-text-box-changes'
                    : freeTextEditors.length > 0
                        ? 'persist-native-free-text-editor-changes'
                        : freeTextNotes.length > 0
                            ? 'persist-native-note-changes'
                            : 'persist-native-note-text-updates',
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
    const nativeProjection = typeof admitted === 'string'
        ? admitted
        : buildClassifiedNativeMutationProjection(plan, canonical, capabilities, admitted, replayPlan);
    const nativeRejection = typeof nativeProjection === 'string'
        ? nativeProjection
        : 'native-write-failed';
    const byteRoute: IPdfSaveByteRouteDecision = {
        route: annotationPlan.route,
        annotationPlan,
        canonical,
        baseBytes: capabilities.hasLoadedSource && annotationPlan.route !== 'pdfjs-materialize'
            ? 'loaded-source'
            : 'pdfjs-materialize',
        sourceFallbackAllowed: annotationPlan.route === 'source-replay',
        nativeRejection,
    };
    if (typeof admitted === 'string' || typeof nativeProjection === 'string') {
        return byteRoute;
    }

    return {
        route: 'native-append',
        annotationRoute: replayPlan,
        replayableAnnotationMutationsAllowed: replayPlan.route === 'source-replay',
        metadataMutationsAllowed: admitted.nativeCapabilities.canPersistNativeMetadataMutations,
        annotationWorkDirty: hasNonShapeAnnotationWork(plan),
        pdfjsMaterializeForced: capabilities.forcePdfjsMaterialize,
        nativeMutationProjection: nativeProjection,
        annotationPlan,
        canonical,
        dirtyState: admitted.dirtyState,
        documentStructure: admitted.documentStructure,
        fallback: byteRoute,
    };
}
