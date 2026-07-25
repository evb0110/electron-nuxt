import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {PDFDocumentProxy} from '@app/types/pdfContracts';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {
    AnnotationEntity,
    AnnotationId,
    IShapeEntity,
    IStickyNoteEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    deriveAnnotationId,
    asAnnotationId,
    mintAnnotationId,
    normalizeAnnotationText,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import { cloneShape } from '@app/modules/pdf-viewer/engine/shapes/cloneShape';
import { getNormalizedShapeStableKey } from '@app/modules/pdf-viewer/engine/annotations/shape-annotation-identity/shapeAnnotationIdentity';
import {
    AnnotationStore,
    type IAnnotationSaveFrontier,
    type IShapeImportProposal,
    type IShapeImportSource,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { ExternalIdentityConflictError } from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {
    buildSerializationPlan,
    type IAnnotationReopenReader,
    verifyAnnotationSave,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';
import {
    configurePdfjsWorkerSrc,
    createPdfjsDocumentOptions,
} from '@app/services/pdfjs/runtimeLib';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {normalizePdfJsAnnotationId} from '@app/utils/pdfAnnotationRefs';
import {
    computeSummaryStableKey,
    getReplayableFreeTextNoteName,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {toMarkerRectFromPdfRect} from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';

const ANNOTATION_VERIFICATION_RANGE_BYTES = 1024 * 1024;

export interface IAnnotationReadModel {
    readonly annotationId: AnnotationId;
    readonly kind: AnnotationEntity['kind'];
    readonly pageIndex: number;
    readonly text: string;
    readonly deleted: boolean;
}

export interface IAnnotationSaveSession {
    readonly frontier: IAnnotationSaveFrontier;
    readonly plan: ReturnType<typeof buildSerializationPlan>;
    readonly materializedPdfRefs: Map<AnnotationId, string>;
}

/** Evidence used to distinguish a newly appended annotation from prior identical content. */
export interface IAnnotationSaveVerificationOptions {readonly preexistingPdfAnnotationRefs?: readonly string[];}

interface IPdfjsReopenedAnnotation {
    readonly id?: string;
    readonly annotationName?: string;
    readonly subtype?: string;
    readonly contents?: string;
    readonly contentsObj?: { readonly str?: string };
    readonly rect?: readonly number[];
    readonly quadPoints?: ArrayLike<number>;
}

function persistentIdentity(comment: IAnnotationCommentSummary) {
    return comment.annotationId
        ?? comment.annotationName
        ?? comment.uid
        ?? comment.id;
}

function isPersistedSummary(comment: IAnnotationCommentSummary) {
    return comment.source === 'pdf'
        || Boolean(normalizePdfJsAnnotationId(comment.annotationId));
}

function toMarkupSubtype(value: string | null | undefined): TMarkupSubtype | null {
    if (value === 'Highlight' || value === 'Underline' || value === 'StrikeOut' || value === 'Squiggly') {
        return value;
    }
    return null;
}

/**
 * The production boundary for annotation state. Existing pdfjs snapshots enter
 * through `ingestLegacySummaries`; UI and persistence consumers leave through
 * read models and revision-frontier save sessions.
 */
export class AnnotationApplication {
    readonly store: AnnotationStore;
    readonly legacyIdentityConflicts = new Set<string>();
    readonly #mintedIds = new Map<string, AnnotationId>();

    constructor(readonly documentKey: string, store = new AnnotationStore()) {
        this.store = store;
    }

    ingestLegacySummaries(comments: readonly IAnnotationCommentSummary[]) {
        comments.forEach((comment) => {
            if (!comment.markerRect || comment.source === 'shape') {
                return;
            }
            const persistentKey = persistentIdentity(comment);
            const persisted = isPersistedSummary(comment);
            const annotationNameId = comment.annotationName
                ? asAnnotationId(comment.annotationName)
                : null;
            const existingByCanonicalPdfName = annotationNameId
                ? this.store.get(annotationNameId)
                : null;
            let annotationId: AnnotationId;
            if (comment.appAnnotationId) {
                annotationId = asAnnotationId(comment.appAnnotationId);
            } else if (existingByCanonicalPdfName) {
                annotationId = annotationNameId!;
            } else if (persisted) {
                annotationId = deriveAnnotationId(this.documentKey, persistentKey);
            } else {
                annotationId = this.#mintedIds.get(persistentKey) ?? mintAnnotationId();
            }
            if (!persisted) this.#mintedIds.set(persistentKey, annotationId);
            const existing = this.store.get(annotationId);
            if (existing) {
                const identifiesSameRecord = Boolean(
                    (Boolean(comment.annotationId) && existing.identity.pdfRef === comment.annotationId)
                    || (Boolean(comment.annotationName) && existing.identity.id === comment.annotationName)
                    || (Boolean(comment.uid) && existing.identity.pdfjsUid === comment.uid)
                    || (Boolean(comment.id) && existing.identity.elementId === comment.id),
                );
                if (!identifiesSameRecord) this.legacyIdentityConflicts.add(persistentIdentity(comment));
                if (identifiesSameRecord && (comment.annotationId || comment.annotationName)) {
                    const {
                        id: _canonicalId,
                        ...existingBindings
                    } = existing.identity;
                    this.store.bindIdentity({
                        annotationId: existing.identity.id,
                        expectedRevision: existing.revision,
                        bindings: {
                            ...existingBindings,
                            ...(comment.annotationId ? {pdfRef: comment.annotationId} : {}),
                            ...(comment.annotationName ? {pdfName: comment.annotationName} : {}),
                        },
                    });
                }
                this.store.acknowledgePendingMarkupSubtype(existing.identity.id, [
                    comment.id,
                    comment.uid ?? '',
                    comment.annotationId ?? '',
                    comment.annotationName ?? '',
                    persistentKey,
                ]);
                return;
            }
            const identity = {
                id: annotationId,
                ...(comment.annotationId ? {pdfRef: comment.annotationId} : {}),
                ...(comment.annotationName ? {pdfName: comment.annotationName} : {}),
                ...(comment.uid ? {pdfjsUid: comment.uid} : {}),
                ...(comment.id ? {elementId: comment.id} : {}),
            };
            const common = {
                identity,
                pageIndex: comment.pageIndex,
                revision: 0,
                persistedRevision: persisted ? 0 : -1,
                deleted: false,
                createdAt: comment.createdAt ?? null,
                modifiedAt: comment.modifiedAt ?? null,
                author: comment.author ?? null,
            } as const;
            const markupSubtype = toMarkupSubtype(comment.subtype);
            if (markupSubtype) {
                const entity = {
                    ...common,
                    kind: 'text-markup',
                    subtype: markupSubtype,
                    text: normalizeAnnotationText(comment.text ?? ''),
                    geometry: [structuredClone(comment.markerRect)],
                    color: comment.color ?? null,
                    opacity: comment.opacity ?? null,
                } as const;
                this.store.import(entity);
                return;
            }
            if (!comment.hasNote) {
                return;
            }
            const entity: IStickyNoteEntity = {
                ...common,
                kind: 'sticky-note',
                text: normalizeAnnotationText(comment.text ?? ''),
                anchor: structuredClone(comment.markerRect),
                color: comment.color ?? null,
            };
            this.store.import(entity);
        });
    }

    reconcileLegacySummaries(
        comments: readonly IAnnotationCommentSummary[],
        options: {
            adoptAsSavedBaseline?: boolean;
            reconcileMissingTransient?: boolean;
        } = {},
    ) {
        const entityIdsBeforeIngest = new Set(this.store.list({includeDeleted: true}).map(entity => entity.identity.id));
        this.ingestLegacySummaries(comments);
        if (options.reconcileMissingTransient === false) {
            return;
        }
        const present = new Set(comments
            .map(comment => this.annotationIdForSummary(comment))
            .filter((value): value is AnnotationId => Boolean(value)));
        // Forward the observed-present canonical ids as a proposal; the store
        // alone decides which transients to tombstone.
        this.store.reconcileObservedTransients(present);
        if (options.adoptAsSavedBaseline) {
            const baselineIds = new Set(comments.flatMap((comment) => {
                const annotationId = this.annotationIdForSummary(comment);
                if (!annotationId || (!isPersistedSummary(comment) && entityIdsBeforeIngest.has(annotationId))) {
                    return [];
                }
                return [annotationId];
            }));
            this.store.adoptEntitiesAsSavedBaseline(baselineIds);
        }
    }

    reconcilePdfjsEditorPresence(presentExternalIds: ReadonlySet<string>) {
        // Forward the rendered external ids as a proposal; the store alone
        // decides canonical restoration and transient tombstoning.
        this.store.reconcileEditorPresence(presentExternalIds);
    }

    /**
     * Translates a scanned document's shape records into canonical proposals.
     * Deriving the id needs this boundary's document key; every decision the
     * proposals feed — mode, adoption, tombstones, baseline — is the store's.
     */
    importEmbeddedShapes(shapes: readonly IShapeAnnotation[], source: IShapeImportSource) {
        return this.store.reconcileImportedShapes(this.#shapeImportProposals(shapes), source);
    }

    primePersistedShapes(
        shapes: readonly IShapeAnnotation[],
        frontier: IAnnotationSaveFrontier,
    ) {
        return this.store.primeImportedShapes(this.#shapeImportProposals(shapes), frontier);
    }

    createShapeFromGeometry(geometry: IShapeAnnotation) {
        return this.store.createShape({
            kind: 'shape',
            identity: {
                id: mintAnnotationId(),
                elementId: geometry.id,
            },
            pageIndex: geometry.pageIndex,
            revision: 0,
            persistedRevision: -1,
            deleted: false,
            createdAt: geometry.createdAt ?? Date.now(),
            modifiedAt: geometry.modifiedAt ?? Date.now(),
            author: null,
            geometry: cloneShape(geometry),
        });
    }

    #shapeImportProposals(shapes: readonly IShapeAnnotation[]): IShapeImportProposal[] {
        return shapes.map(shape => ({
            annotationId: deriveAnnotationId(
                this.documentKey,
                shape.annotationId ?? getNormalizedShapeStableKey(shape) ?? shape.id,
            ),
            geometry: cloneShape(shape),
        }));
    }

    listReadModels(): readonly IAnnotationReadModel[] {
        return this.store.list({includeDeleted: true}).map(entity => ({
            annotationId: entity.identity.id,
            kind: entity.kind,
            pageIndex: entity.pageIndex,
            text: entity.kind === 'shape' ? '' : entity.text,
            deleted: entity.deleted,
        }));
    }

    /** Immutable UI projection derived only from canonical entities. */
    listCommentSummaries(): readonly IAnnotationCommentSummary[] {
        return this.store.list().flatMap((entity) => {
            if (entity.kind === 'shape') {
                return [];
            }
            const source = entity.persistedRevision >= 0 ? 'pdf' : 'editor';
            const externalId = entity.identity.elementId
                ?? entity.identity.pdfRef
                ?? entity.identity.pdfjsUid
                ?? entity.identity.id;
            const stableKey = entity.identity.pdfRef
                ? `ann:${entity.pageIndex}:${entity.identity.pdfRef}` as const
                : entity.identity.pdfjsUid
                    ? `uid:${entity.pageIndex}:${entity.identity.pdfjsUid}` as const
                    : `src:${source}:${entity.pageIndex}:${externalId}` as const;
            const markerRect = entity.kind === 'sticky-note'
                ? structuredClone(entity.anchor)
                : structuredClone(entity.geometry[0] ?? null);
            return [{
                source,
                appAnnotationId: entity.identity.id,
                id: externalId,
                stableKey,
                pageIndex: entity.pageIndex,
                pageNumber: entity.pageIndex + 1,
                text: entity.text,
                subtype: entity.kind === 'text-markup' ? entity.subtype : 'FreeText',
                author: entity.author,
                createdAt: entity.createdAt,
                modifiedAt: entity.modifiedAt,
                color: entity.color,
                ...(entity.kind === 'text-markup' ? {opacity: entity.opacity} : {}),
                uid: entity.identity.pdfjsUid ?? null,
                annotationId: entity.identity.pdfRef ?? null,
                annotationName: entity.identity.pdfName ?? null,
                hasNote: entity.kind === 'sticky-note' || entity.text.length > 0,
                markerRect,
            } satisfies IAnnotationCommentSummary];
        });
    }

    projectSummaries(comments: readonly IAnnotationCommentSummary[]) {
        return comments.flatMap((comment) => {
            const annotationId = comment.appAnnotationId
                ? asAnnotationId(comment.appAnnotationId)
                : this.annotationIdForSummary(comment);
            if (!annotationId) {
                return [comment];
            }
            const entity = this.store.get(annotationId);
            if (!entity || entity.deleted) {
                return [];
            }
            if (entity.kind === 'sticky-note') {
                return [{
                    ...comment,
                    appAnnotationId: annotationId,
                    pageIndex: entity.pageIndex,
                    pageNumber: entity.pageIndex + 1,
                    text: entity.text,
                    markerRect: structuredClone(entity.anchor),
                    color: entity.color,
                    author: entity.author,
                    createdAt: entity.createdAt,
                    modifiedAt: entity.modifiedAt,
                    hasNote: true,
                }];
            }
            if (entity.kind === 'text-markup') {
                return [{
                    ...comment,
                    appAnnotationId: annotationId,
                    pageIndex: entity.pageIndex,
                    pageNumber: entity.pageIndex + 1,
                    text: entity.text,
                    subtype: entity.subtype,
                    markerRect: structuredClone(entity.geometry[0] ?? comment.markerRect ?? null),
                    color: entity.color,
                    opacity: entity.opacity,
                    author: entity.author,
                    createdAt: entity.createdAt,
                    modifiedAt: entity.modifiedAt,
                }];
            }
            return [{
                ...comment,
                appAnnotationId: annotationId,
                pageIndex: entity.pageIndex,
                pageNumber: entity.pageIndex + 1,
            }];
        });
    }

    annotationIdForSummary(comment: IAnnotationCommentSummary) {
        if (comment.appAnnotationId) {
            const annotationId = asAnnotationId(comment.appAnnotationId);
            if (this.store.get(annotationId)) {
                return annotationId;
            }
        }
        return this.store.resolveExternal({
            ...(comment.annotationId ? {pdfRef: comment.annotationId} : {}),
            ...(comment.annotationName ? {pdfName: comment.annotationName} : {}),
            ...(comment.uid ? {pdfjsUid: comment.uid} : {}),
            ...(comment.id ? {elementId: comment.id} : {}),
        });
    }

    annotationIdForShape(shape: Pick<IShapeAnnotation, 'id' | 'annotationId'>) {
        return this.store.resolveExternal({
            ...(shape.annotationId ? {pdfRef: shape.annotationId} : {}),
            elementId: shape.id,
        });
    }

    replaceShapeGeometry(
        annotationId: AnnotationId,
        geometry: IShapeEntity['geometry'],
        historyBeforeGeometry?: IShapeEntity['geometry'],
    ) {
        return this.store.replaceShapeGeometry(annotationId, geometry, historyBeforeGeometry);
    }

    previewShapeGeometry(annotationId: AnnotationId, geometry: IShapeEntity['geometry']) {
        return this.store.previewShapeGeometry(annotationId, geometry);
    }

    remapPages(delta: IPageIdentityDelta) { this.store.remapPages(delta); }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveSession {
        if (this.legacyIdentityConflicts.size) {
            throw new ExternalIdentityConflictError(`Ambiguous legacy annotation identities: ${Array.from(this.legacyIdentityConflicts).join(', ')}`);
        }
        const frontier = this.store.beginSave(documentRevisionToken);
        return {
            frontier,
            materializedPdfRefs: new Map(),
            plan: buildSerializationPlan(
                frontier,
                this.store.dirtyAt(frontier),
                this.store.list({includeDeleted: true}),
            ),
        };
    }

    recordMaterializedIdentityBinding(
        session: IAnnotationSaveSession,
        annotationId: string,
        pdfRef: string,
    ) {
        const canonicalId = asAnnotationId(annotationId);
        if (!session.frontier.revisions.has(canonicalId)) {
            throw new Error(`Unexpected materialized annotation identity ${annotationId}`);
        }
        const existing = session.materializedPdfRefs.get(canonicalId);
        if (existing && normalizePdfJsAnnotationId(existing) !== normalizePdfJsAnnotationId(pdfRef)) {
            throw new Error(`Conflicting materialized PDF refs for ${annotationId}`);
        }
        session.materializedPdfRefs.set(canonicalId, pdfRef);
    }

    async verifyAndAcknowledgeSave(
        session: IAnnotationSaveSession,
        bytes: Uint8Array,
        reader: IAnnotationReopenReader,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = session.frontier.documentRevisionToken,
    ) {
        await verifyAnnotationSave(bytes, session.plan, reader);
        this.store.acknowledgeSave(
            session.frontier,
            session.materializedPdfRefs,
            currentDocumentRevisionToken,
        );
    }

    async verifySaveBytes(
        session: IAnnotationSaveSession,
        bytes: Uint8Array,
        options: IAnnotationSaveVerificationOptions = {},
    ) {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        configurePdfjsWorkerSrc(pdfjs);
        const loadingTask = pdfjs.getDocument({
            ...createPdfjsDocumentOptions(pdfjs),
            data: bytes.slice(),
        });
        const document = await loadingTask.promise;
        try {
            await this.#verifySaveDocument(session, document, bytes, options);
        } finally {
            await document.destroy();
        }
    }

    async verifySavePath(
        session: IAnnotationSaveSession,
        path: string,
        knownSize: number,
        options: IAnnotationSaveVerificationOptions = {},
    ) {
        if (!Number.isSafeInteger(knownSize) || knownSize <= 0) {
            throw new Error('Path-backed annotation verification requires a positive safe file size');
        }
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        configurePdfjsWorkerSrc(pdfjs);
        const documentFiles = getDocumentFilesCapability();
        const before = await documentFiles.statFile(path);
        if (before.size !== knownSize) {
            throw new Error('Staged PDF changed before semantic verification');
        }
        const initialLength = Math.min(knownSize, ANNOTATION_VERIFICATION_RANGE_BYTES);
        const initialData = await documentFiles.readFileRange(path, 0, initialLength);
        if (initialData.byteLength !== initialLength) {
            throw new Error('Staged PDF returned an incomplete initial verification range');
        }
        if (knownSize <= ANNOTATION_VERIFICATION_RANGE_BYTES) {
            return this.verifySaveBytes(session, initialData, options);
        }

        let rejectRangeRead: (error: Error) => void = () => undefined;
        const rangeReadFailure = new Promise<never>((_resolve, reject) => {
            rejectRangeRead = reject;
        });
        let failed = false;
        class AnnotationVerificationRangeTransport extends pdfjs.PDFDataRangeTransport {
            private aborted = false;

            public constructor() {
                super(knownSize, initialData, false);
            }

            public override requestDataRange = (begin: number, end: number) => {
                if (this.aborted || failed || end <= begin) {
                    return;
                }
                void documentFiles.readFileRange(path, begin, end - begin).then((chunk) => {
                    if (this.aborted || failed) {
                        return;
                    }
                    if (chunk.byteLength !== end - begin) {
                        throw new Error('Staged PDF returned an incomplete semantic verification range');
                    }
                    this.onDataRange(begin, chunk);
                }).catch((error: unknown) => {
                    if (this.aborted || failed) {
                        return;
                    }
                    failed = true;
                    rejectRangeRead(error instanceof Error ? error : new Error(String(error)));
                });
            };

            public override abort = () => {
                this.aborted = true;
            };
        }

        const range = new AnnotationVerificationRangeTransport();
        const loadingTask = pdfjs.getDocument({
            ...createPdfjsDocumentOptions(pdfjs),
            length: knownSize,
            range,
            rangeChunkSize: ANNOTATION_VERIFICATION_RANGE_BYTES,
            disableAutoFetch: true,
            disableStream: true,
        });
        let document: PDFDocumentProxy | null = null;
        try {
            document = await Promise.race([
                loadingTask.promise,
                rangeReadFailure,
            ]);
            await Promise.race([
                this.#verifySaveDocument(session, document, initialData, options),
                rangeReadFailure,
            ]);
            const after = await documentFiles.statFile(path);
            if (after.size !== knownSize) {
                throw new Error('Staged PDF changed during semantic verification');
            }
        } finally {
            range.abort();
            if (document) {
                await document.destroy();
            } else {
                await loadingTask.destroy();
            }
        }
    }

    async #verifySaveDocument(
        session: IAnnotationSaveSession,
        document: PDFDocumentProxy,
        verificationToken: Uint8Array,
        options: IAnnotationSaveVerificationOptions,
    ) {
        const reopened: AnnotationEntity[] = [];
        const matchedRecords = new Set<IPdfjsReopenedAnnotation>();
        const preexistingPdfRefs = options.preexistingPdfAnnotationRefs === undefined
            ? null
            : new Set(options.preexistingPdfAnnotationRefs
                .map(value => normalizePdfJsAnnotationId(value))
                .filter((value): value is string => Boolean(value)));
        for (const expected of session.plan.expected) {
            if (expected.deleted && expected.pageIndex >= document.numPages) {
                continue;
            }
            const page = await document.getPage(expected.pageIndex + 1);
            const records: readonly IPdfjsReopenedAnnotation[] = await page.getAnnotations();
            const externalIds = new Set([
                expected.identity.id,
                expected.identity.pdfRef,
                expected.identity.pdfName,
                expected.identity.pdfjsUid,
                expected.identity.elementId,
                session.materializedPdfRefs.get(expected.identity.id),
            ].filter((value): value is string => Boolean(value)));
            if (expected.kind === 'sticky-note' && !expected.identity.pdfRef && !expected.identity.pdfName) {
                const id = expected.identity.elementId
                    ?? expected.identity.pdfjsUid
                    ?? expected.identity.id;
                const nativeName = getReplayableFreeTextNoteName({
                    stableKey: computeSummaryStableKey({
                        id,
                        pageIndex: expected.pageIndex,
                        source: 'editor',
                        uid: expected.identity.pdfjsUid ?? null,
                        annotationId: null,
                    }),
                    createdAt: expected.createdAt,
                });
                if (nativeName) externalIds.add(nativeName);
            }
            let record = records.find(candidate => !matchedRecords.has(candidate) && (
                (typeof candidate.id === 'string' && externalIds.has(candidate.id))
                || (typeof candidate.annotationName === 'string' && externalIds.has(candidate.annotationName))
                || (typeof candidate.id === 'string' && externalIds.has(candidate.id.replace(/R0$/u, 'R')))
            ));
            if (
                !record
                && preexistingPdfRefs
                && expected.kind === 'sticky-note'
                && !expected.identity.pdfRef
                && !expected.identity.pdfName
            ) {
                const semanticCandidates = records.filter((candidate) => {
                    if (matchedRecords.has(candidate) || candidate.subtype !== 'FreeText') {
                        return false;
                    }
                    const candidateRef = normalizePdfJsAnnotationId(candidate.id);
                    if (!candidateRef || preexistingPdfRefs.has(candidateRef)) {
                        return false;
                    }
                    const candidateText = normalizeAnnotationText(
                        candidate.contentsObj?.str ?? candidate.contents ?? '',
                    );
                    const candidateRect = this.#normalizePdfRect(candidate.rect, page.view);
                    return candidateText === expected.text
                        && Boolean(candidateRect)
                        && Math.abs(candidateRect!.left - expected.anchor.left) <= 0.0001
                        && Math.abs(candidateRect!.top - expected.anchor.top) <= 0.0001
                        && Math.abs(candidateRect!.width - expected.anchor.width) <= 0.0001
                        && Math.abs(candidateRect!.height - expected.anchor.height) <= 0.0001;
                });
                if (semanticCandidates.length === 1) {
                    [record] = semanticCandidates;
                }
            }
            if (record) {
                matchedRecords.add(record);
                if (
                    !expected.identity.pdfRef
                    && typeof record.id === 'string'
                    && normalizePdfJsAnnotationId(record.id)
                ) {
                    session.materializedPdfRefs.set(expected.identity.id, record.id);
                }
            }
            if (expected.deleted) {
                if (record) reopened.push({
                    ...expected,
                    deleted: false,
                });
                continue;
            }
            if (!record) continue;
            const rect = this.#normalizePdfRect(record.rect, page.view);
            if (expected.kind === 'sticky-note') {
                reopened.push({
                    ...expected,
                    text: normalizeAnnotationText(record.contentsObj?.str ?? record.contents ?? ''),
                    ...(rect ? {anchor: rect} : {}),
                });
            } else if (expected.kind === 'text-markup') {
                const subtype = toMarkupSubtype(record.subtype);
                if (!subtype) continue;
                const quadGeometry = this.#normalizePdfQuadPoints(record.quadPoints, page.view);
                reopened.push({
                    ...expected,
                    subtype,
                    text: normalizeAnnotationText(record.contentsObj?.str ?? record.contents ?? ''),
                    ...(quadGeometry.length
                        ? {geometry: quadGeometry}
                        : rect
                            ? {geometry: [rect]}
                            : {}),
                });
            } else {
                reopened.push(expected);
            }
        }
        await verifyAnnotationSave(verificationToken, session.plan, {reopen: () => Promise.resolve(reopened)});
    }

    acknowledgeSave(
        session: IAnnotationSaveSession,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = session.frontier.documentRevisionToken,
    ) {
        this.store.acknowledgeSave(
            session.frontier,
            session.materializedPdfRefs,
            currentDocumentRevisionToken,
        );
    }

    /** Reports whether this authority still owned the failed save's frontier. */
    rollbackSave(session: IAnnotationSaveSession) {
        return this.store.rollbackToSaveFrontier(session.frontier);
    }

    assertSaveCurrent(
        session: IAnnotationSaveSession,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = session.frontier.documentRevisionToken,
    ) {
        this.store.assertSaveFrontierCurrent(session.frontier, currentDocumentRevisionToken);
    }

    #normalizePdfRect(rect: readonly number[] | undefined, view: readonly number[]) {
        return toMarkerRectFromPdfRect(
            rect ? [...rect] : undefined,
            [...view],
        );
    }

    #normalizePdfQuadPoints(quadPoints: ArrayLike<number> | undefined, view: readonly number[]) {
        const geometry: IAnnotationMarkerRect[] = [];
        if (!quadPoints || quadPoints.length < 8) {
            return geometry;
        }
        for (let index = 0; index + 7 < quadPoints.length; index += 8) {
            const points = Array.from({length: 8}, (_unused, offset) => quadPoints[index + offset]);
            if (!points.every(value => typeof value === 'number' && Number.isFinite(value))) {
                continue;
            }
            const xs = [
                points[0]!,
                points[2]!,
                points[4]!,
                points[6]!,
            ];
            const ys = [
                points[1]!,
                points[3]!,
                points[5]!,
                points[7]!,
            ];
            const rect = this.#normalizePdfRect([
                Math.min(...xs),
                Math.min(...ys),
                Math.max(...xs),
                Math.max(...ys),
            ], view);
            if (rect) {
                geometry.push(rect);
            }
        }
        return geometry;
    }
}
