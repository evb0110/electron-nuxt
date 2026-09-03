import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
    TDrawableShapeType,
} from '@app/types/annotations';
import type {PDFDocumentProxy} from '@app/types/pdfContracts';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {measureOperationPhase} from '@contracts/measureOperationPhase';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {
    AnnotationEntity,
    AnnotationId,
    IShapeEntity,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';

import {
    asAnnotationId,
    deriveAnnotationId,
    mintAnnotationId,
    normalizeAnnotationText,
    toLegacyShapeAnnotation,
} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import {
    AnnotationStore,
    type IAnnotationSaveFrontier,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
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
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import {getReplayableFreeTextNoteName} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import {toMarkerRectFromPdfRect} from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import {toCanonicalTextMarkupGeometryFromRecord} from '@app/modules/pdf-viewer/engine/annotation-geometry/canonicalTextMarkupGeometry';
import type {TPageRotation} from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import {normalizePageRotation} from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import type {IPdfAnnotationRecord} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import {buildPopupIndex} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/buildPopupIndex';
import {resolvePdfAnnotationCommentText} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/buildPdfAnnotationCommentSummary';
import {resolveCombinedAnnotationText} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveCombinedAnnotationText';
import {resolvePdfAnnotationPreviewText} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';
import {getOptionalNumber} from '@app/services/pdfjs/runtime';
import {isTextMarkupSubtype} from '@app/services/pdf/annotationSubtype';
import {BrowserLogger} from '@app/utils/browserLogger';

const ANNOTATION_VERIFICATION_RANGE_BYTES = 1024 * 1024;
const SLOW_ANNOTATION_PATH_VERIFICATION_MS = 1_000;

interface IAnnotationPathVerificationTiming {
    readonly phase: string;
    readonly durationMs: number;
}

function roundAnnotationVerificationDuration(durationMs: number) {
    return Math.round(durationMs * 10) / 10;
}

function parseNativePdfObjectRef(pdfRef: string) {
    const match = pdfRef.trim().match(/^([1-9]\d*) ([0-9]+) R$/u);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = Number(match[2]);
    if (
        !Number.isSafeInteger(objectNumber)
        || !Number.isSafeInteger(generationNumber)
        || objectNumber <= 0
        || generationNumber < 0
    ) {
        return null;
    }

    return {
        objectNumber,
        generationNumber,
    };
}

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

/**
 * One reopened page, read exactly the way the opened document reads a page: the
 * same records, the same popup pairing, the same page view box and `/Rotate`.
 * Verification compares a store entity against the file, and the entity was
 * built from these same inputs, so anything the reopen resolves differently
 * would be reported as a save failure that never happened.
 */
interface IVerificationPage {
    readonly records: readonly IPdfAnnotationRecord[];
    readonly pageView: number[];
    readonly pageRotation: TPageRotation;
    /** The annotation's own note text, popup-linked notes included. */
    resolveNoteText(record: IPdfAnnotationRecord): Promise<string>;
}

function normalizedPdfRef(value: string | null | undefined) {
    return normalizePdfJsAnnotationId(value);
}

function toMarkupSubtype(value: string | null | undefined): TMarkupSubtype | null {
    if (value === 'Highlight' || value === 'Underline' || value === 'StrikeOut' || value === 'Squiggly') {
        return value;
    }
    return null;
}

/**
 * The production boundary for annotation state. Existing pdfjs snapshots enter
 * through the temporary summary adapter; UI and persistence consumers leave
 * through read models and revision-frontier save sessions.
 */

function shapeToolFromLegacyShape(shape: IShapeAnnotation): TDrawableShapeType {
    if (shape.type === 'polyline') {
        return 'draw';
    }
    if (shape.type === 'arrow') {
        return 'arrow';
    }
    if (shape.type === 'line' && shape.lineEndStyle === 'closedArrow') {
        return 'arrow';
    }
    return shape.type === 'rectangle' || shape.type === 'circle' || shape.type === 'line'
        ? shape.type
        : 'draw';
}

export function toCanonicalShapeEntity(
    shape: IShapeAnnotation,
    id: AnnotationId = mintAnnotationId(),
): IShapeEntity {
    const pdfRef = normalizedPdfRef(shape.annotationId);
    const tool = shapeToolFromLegacyShape(shape);
    const linePoints = tool === 'line' || tool === 'arrow'
        ? [
            {
                x: shape.x,
                y: shape.y,
            },
            {
                x: shape.x2 ?? shape.x + shape.width,
                y: shape.y2 ?? shape.y + shape.height,
            },
        ]
        : null;
    const geometryPoints = shape.points ?? linePoints;
    const allGeometryPoints = geometryPoints ?? shape.strokes?.flatMap(stroke => stroke) ?? [];
    const hasPointBounds = allGeometryPoints.length > 0;
    const geometryLeft = hasPointBounds
        ? Math.min(...allGeometryPoints.map(point => point.x))
        : shape.x;
    const geometryTop = hasPointBounds
        ? Math.min(...allGeometryPoints.map(point => point.y))
        : shape.y;
    const geometryRight = hasPointBounds
        ? Math.max(...allGeometryPoints.map(point => point.x))
        : null;
    const geometryBottom = hasPointBounds
        ? Math.max(...allGeometryPoints.map(point => point.y))
        : null;
    return {
        kind: 'shape',
        identity: {
            id,
            ...(pdfRef ? {pdfRef} : {}),
        },
        pageIndex: shape.pageIndex,
        revision: 0,
        persistedRevision: pdfRef ? 0 : -1,
        deleted: false,
        createdAt: shape.createdAt ?? null,
        modifiedAt: shape.modifiedAt ?? null,
        author: null,
        tool,
        rect: {
            left: geometryLeft,
            top: geometryTop,
            width: hasPointBounds ? geometryRight! - geometryLeft : shape.width,
            height: hasPointBounds ? geometryBottom! - geometryTop : shape.height,
        },
        ...(geometryPoints === undefined || geometryPoints === null ? {} : {points: structuredClone(geometryPoints)}),
        ...(shape.strokes === undefined ? {} : {strokes: structuredClone(shape.strokes)}),
        strokeColor: shape.color,
        strokeWidth: shape.strokeWidth,
        fill: shape.fillColor ?? null,
        opacity: shape.opacity,
    };
}

export class AnnotationApplication {
    readonly store: AnnotationStore;

    constructor(readonly documentKey: string, store = new AnnotationStore()) {
        this.store = store;
    }

    listReadModels(): readonly IAnnotationReadModel[] {
        return this.store.list({includeDeleted: true}).map(entity => ({
            annotationId: entity.identity.id,
            kind: entity.kind,
            pageIndex: entity.pageIndex,
            text: entity.kind === 'text-box'
                ? entity.text
                : entity.kind === 'note'
                    ? entity.contents
                    : entity.kind === 'text-markup'
                        ? entity.contents
                        : '',
            deleted: entity.deleted,
        }));
    }

    /**
     * Temporary adapter for the PDF.js comment scanner. The parser lane will
     * call replaceFromDocument with entities directly once it owns canonical
     * construction. Keeping this conversion here prevents summary DTOs from
     * becoming retained store state in the meantime.
     */
    replaceFromDocumentSummaries(comments: readonly IAnnotationCommentSummary[]) {
        const existingByPdfRef = new Map<string, AnnotationId>();
        this.store.list({includeDeleted: true}).forEach((entity) => {
            const pdfRef = normalizedPdfRef(entity.identity.pdfRef);
            if (pdfRef) {
                existingByPdfRef.set(pdfRef, entity.identity.id);
            }
        });
        const entitiesById = new Map<AnnotationId, {
            entity: AnnotationEntity;
            source: IAnnotationCommentSummary['source']
        }>();
        const entitiesByPdfRef = new Map(existingByPdfRef);
        comments.forEach((comment) => {
            if (comment.source === 'shape' || !comment.markerRect) {
                return;
            }
            // A Stamp needs image bytes and dimensions that this summary
            // adapter does not receive. The native parser owns that boundary.
            if (comment.subtype === 'Stamp') {
                return;
            }
            // PDF.js creates empty editor placeholders while a FreeText editor
            // is being mounted. They are not authored annotations and must not
            // enter the canonical store as transient text boxes.
            if (comment.source === 'editor'
                && comment.subtype === 'FreeText'
                && !normalizeAnnotationText(comment.text)
                && /^pdfjs_internal_editor_\d+$/u.test(comment.id.trim())) {
                return;
            }
            const pdfRef = normalizedPdfRef(comment.annotationId);
            const existingId = pdfRef ? entitiesByPdfRef.get(pdfRef) : undefined;
            const id = existingId
                ?? (comment.appAnnotationId ? asAnnotationId(comment.appAnnotationId) : null)
                ?? deriveAnnotationId(
                    this.documentKey,
                    `${comment.source}:${comment.pageIndex}:${comment.id}`,
                );
            const persisted = comment.source === 'pdf' || Boolean(pdfRef);
            const common = {
                identity: {
                    id,
                    ...(pdfRef ? {pdfRef} : {}),
                },
                pageIndex: comment.pageIndex,
                revision: 0,
                persistedRevision: persisted ? 0 : -1,
                deleted: false,
                createdAt: comment.createdAt ?? null,
                modifiedAt: comment.modifiedAt ?? null,
                author: comment.author ?? null,
            } as const;
            const markupSubtype = toMarkupSubtype(comment.subtype);
            let entity: AnnotationEntity;
            if (markupSubtype) {
                const quadPoints = comment.markupGeometry?.length
                    ? comment.markupGeometry.map(rect => structuredClone(rect))
                    : [structuredClone(comment.markerRect)];
                entity = {
                    ...common,
                    kind: 'text-markup',
                    subtype: markupSubtype,
                    contents: normalizeAnnotationText(comment.text),
                    quadPoints,
                    color: comment.color ?? null,
                    opacity: comment.opacity ?? null,
                    selectedText: comment.previewText ?? null,
                };
            } else if (comment.hasNote === true || comment.subtype === 'Text') {
                entity = {
                    ...common,
                    kind: 'note',
                    contents: normalizeAnnotationText(comment.text),
                    position: structuredClone(comment.markerRect),
                    color: comment.color ?? null,
                    open: false,
                    ...(comment.replies
                        ? {replies: comment.replies.map(reply => ({...reply}))}
                        : {}),
                };
            } else {
                entity = {
                    ...common,
                    kind: 'text-box',
                    text: normalizeAnnotationText(comment.text),
                    rect: structuredClone(comment.markerRect),
                    rotation: 0,
                    fontSize: 10,
                    color: comment.color ?? null,
                };
            }
            const existing = entitiesById.get(id);
            if (!existing || (existing.source === 'editor' && comment.source === 'pdf')) {
                entitiesById.set(id, {
                    entity,
                    source: comment.source,
                });
            }
            if (pdfRef) {
                entitiesByPdfRef.set(pdfRef, id);
            }
        });
        // The summary adapter does not carry enough data to parse shapes or
        // placed images. Keep the canonical entities that this lane skipped,
        // including their tombstones, until the authoritative document parser
        // replaces them. The foreign report follows the same rule.
        const parsedEntities = Array.from(entitiesById.values(), value => value.entity);
        const preservedEntities = this.store.list({includeDeleted: true})
            .filter(entity => (entity.kind === 'shape' || entity.kind === 'placed-image')
                && !entitiesById.has(entity.identity.id));
        this.store.replaceFromDocument(
            [
                ...parsedEntities,
                ...preservedEntities,
            ],
            this.store.foreign,
        );
        return this.listCommentSummaries();
    }

    /**
     * Returns the PDF references of deleted canonical annotations. The
     * suppression set is derived from the store's tombstones, so the UI has no
     * second deletion ledger.
     */
    deletedEmbeddedAnnotationIds(): ReadonlySet<string> {
        const ids = new Set<string>();
        this.store.list({includeDeleted: true}).forEach((entity) => {
            if (!entity.deleted) {
                return;
            }
            const annotationId = normalizePdfJsAnnotationId(entity.identity.pdfRef);
            if (annotationId) {
                ids.add(annotationId);
            }
        });
        return ids;
    }

    listCommentSummaries(): readonly IAnnotationCommentSummary[] {
        return this.store.list().flatMap((entity) => {
            if (entity.kind === 'shape') {
                return [];
            }
            const source = entity.persistedRevision >= 0 ? 'pdf' as const : 'editor' as const;
            const externalId = entity.identity.pdfRef ?? entity.identity.id;
            const stableKey: IAnnotationCommentSummary['stableKey'] = entity.identity.pdfRef
                ? `ann:${entity.pageIndex}:${entity.identity.pdfRef}`
                : `ann:${entity.pageIndex}:${entity.identity.id}`;
            const markerRect = entity.kind === 'text-box'
                ? structuredClone(entity.rect)
                : entity.kind === 'note'
                    ? structuredClone(entity.position)
                    : entity.kind === 'text-markup'
                        ? structuredClone(entity.quadPoints[0] ?? null)
                        : structuredClone(entity.rect);
            const text = entity.kind === 'text-box'
                ? entity.text
                : entity.kind === 'note'
                    ? entity.contents
                    : entity.kind === 'text-markup'
                        ? entity.contents
                        : '';
            const subtype = entity.kind === 'text-markup'
                ? entity.subtype
                : entity.kind === 'note'
                    ? 'Text'
                    : entity.kind === 'text-box'
                        ? 'FreeText'
                        : 'Stamp';
            return [{
                source,
                appAnnotationId: entity.identity.id,
                id: externalId,
                stableKey,
                pageIndex: entity.pageIndex,
                pageNumber: entity.pageIndex + 1,
                text,
                ...(entity.kind === 'text-markup'
                    ? {previewText: entity.selectedText ?? null}
                    : {}),
                subtype,
                author: entity.author,
                createdAt: entity.createdAt,
                modifiedAt: entity.modifiedAt,
                color: entity.kind === 'text-box'
                    || entity.kind === 'note'
                    || entity.kind === 'text-markup'
                    ? entity.color
                    : null,
                ...(entity.kind === 'text-markup' ? {opacity: entity.opacity} : {}),
                uid: null,
                annotationId: entity.identity.pdfRef ?? null,
                annotationName: null,
                hasNote: entity.kind === 'note'
                    || (entity.kind !== 'placed-image' && text.length > 0),
                markerRect,
                ...(entity.kind === 'note' && entity.replies
                    ? {replies: entity.replies.map(reply => ({...reply}))}
                    : {}),
                ...(entity.kind === 'text-markup'
                    ? {markupGeometry: structuredClone(entity.quadPoints)}
                    : {}),
            } satisfies IAnnotationCommentSummary];
        });
    }

    annotationIdForSummary(comment: IAnnotationCommentSummary): AnnotationId | null {
        if (comment.appAnnotationId) {
            const id = asAnnotationId(comment.appAnnotationId);
            if (this.store.get(id)) {
                return id;
            }
        }
        const pdfRef = normalizedPdfRef(comment.annotationId);
        if (!pdfRef) {
            return null;
        }
        return this.store.list({includeDeleted: true})
            .find(entity => normalizedPdfRef(entity.identity.pdfRef) === pdfRef)
            ?.identity.id ?? null;
    }

    annotationIdForShape(shape: Pick<IShapeAnnotation, 'id' | 'annotationId'>): AnnotationId | null {
        const byId = this.store.get(asAnnotationId(shape.id));
        if (byId?.kind === 'shape') {
            return byId.identity.id;
        }
        const pdfRef = normalizedPdfRef(shape.annotationId);
        return pdfRef
            ? this.store.list({includeDeleted: true})
                .find(entity => entity.kind === 'shape'
                    && normalizedPdfRef(entity.identity.pdfRef) === pdfRef)
                ?.identity.id ?? null
            : null;
    }

    toLegacyShape(entity: IShapeEntity): IShapeAnnotation {
        return toLegacyShapeAnnotation(entity);
    }

    remapPages(delta: IPageIdentityDelta) {
        this.store.remapPages(delta);
    }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveSession {
        const frontier = this.store.beginSave(documentRevisionToken);
        const dirty = this.store.dirtyEntities();
        return {
            frontier,
            materializedPdfRefs: new Map(),
            plan: buildSerializationPlan(
                frontier,
                dirty,
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
        const parsedPdfRef = parseNativePdfObjectRef(pdfRef) ?? parsePdfJsAnnotationRef(pdfRef);
        if (!parsedPdfRef) {
            throw new Error(`Malformed materialized PDF ref for ${annotationId}`);
        }
        const normalizedPdfRef = formatPdfJsAnnotationRef(parsedPdfRef);
        const existing = session.materializedPdfRefs.get(canonicalId);
        if (existing && normalizePdfJsAnnotationId(existing) !== normalizedPdfRef) {
            throw new Error(`Conflicting materialized PDF refs for ${annotationId}`);
        }
        session.materializedPdfRefs.set(canonicalId, normalizedPdfRef);
    }

    async verifyAndAcknowledgeSave(
        session: IAnnotationSaveSession,
        bytes: Uint8Array,
        reader: IAnnotationReopenReader,
        currentDocumentRevisionToken: TDocumentRevisionToken | null = session.frontier.documentRevisionToken,
    ) {
        await verifyAnnotationSave(bytes, session.plan, reader);
        this.store.markPersisted(
            session.frontier,
            this.#materializedPdfIdentityBindings(session),
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
        const verificationStartedAt = performance.now();
        const timings: IAnnotationPathVerificationTiming[] = [];
        const measure = <T>(phase: string, operation: () => Promise<T>) =>
            measureOperationPhase(operation, durationMs => timings.push({
                phase,
                durationMs,
            }));
        let rangeReadCount = 0;
        let rangeReadBytes = 0;
        let rangeReadTotalMs = 0;
        let rangeReadMaxMs = 0;
        let outcome: 'success' | 'failure' = 'failure';
        if (!Number.isSafeInteger(knownSize) || knownSize <= 0) {
            throw new Error('Path-backed annotation verification requires a positive safe file size');
        }
        const pdfjs = await measure(
            'import-pdfjs',
            () => import('pdfjs-dist/legacy/build/pdf.mjs'),
        );
        configurePdfjsWorkerSrc(pdfjs);
        const documentFiles = getDocumentFilesCapability();
        const before = await measure('stat-before', () => documentFiles.statFile(path));
        if (before.size !== knownSize) {
            throw new Error('Staged PDF changed before semantic verification');
        }
        const initialLength = Math.min(knownSize, ANNOTATION_VERIFICATION_RANGE_BYTES);
        const initialData = await measure(
            'read-initial-range',
            () => documentFiles.readFileRange(path, 0, initialLength),
        );
        if (initialData.byteLength !== initialLength) {
            throw new Error('Staged PDF returned an incomplete initial verification range');
        }
        if (knownSize <= ANNOTATION_VERIFICATION_RANGE_BYTES) {
            try {
                await measure(
                    'verify-small-bytes',
                    () => this.verifySaveBytes(session, initialData, options),
                );
                outcome = 'success';
                return;
            } finally {
                const totalMs = roundAnnotationVerificationDuration(
                    performance.now() - verificationStartedAt,
                );
                if (totalMs >= SLOW_ANNOTATION_PATH_VERIFICATION_MS) {
                    BrowserLogger.warn('annotations', 'Slow staged annotation verification', {
                        totalMs,
                        knownSize,
                        timings,
                        rangeReadCount,
                        rangeReadBytes,
                        rangeReadTotalMs: roundAnnotationVerificationDuration(rangeReadTotalMs),
                        rangeReadMaxMs: roundAnnotationVerificationDuration(rangeReadMaxMs),
                        outcome,
                    });
                }
            }
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
                const startedAt = performance.now();
                const requestedBytes = end - begin;
                rangeReadCount += 1;
                rangeReadBytes += requestedBytes;
                void documentFiles.readFileRange(path, begin, requestedBytes).then((chunk) => {
                    const durationMs = performance.now() - startedAt;
                    rangeReadTotalMs += durationMs;
                    rangeReadMaxMs = Math.max(rangeReadMaxMs, durationMs);
                    if (this.aborted || failed) {
                        return;
                    }
                    if (chunk.byteLength !== requestedBytes) {
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
            document = await measure('load-document', () => Promise.race([
                loadingTask.promise,
                rangeReadFailure,
            ]));
            await measure('verify-expected-annotations', () => Promise.race([
                this.#verifySaveDocument(session, document!, initialData, options),
                rangeReadFailure,
            ]));
            const after = await measure('stat-after', () => documentFiles.statFile(path));
            if (after.size !== knownSize) {
                throw new Error('Staged PDF changed during semantic verification');
            }
            outcome = 'success';
        } finally {
            range.abort();
            await measure('destroy-document', async () => {
                if (document) {
                    await document.destroy();
                } else {
                    await loadingTask.destroy();
                }
            });
            const totalMs = roundAnnotationVerificationDuration(
                performance.now() - verificationStartedAt,
            );
            if (totalMs >= SLOW_ANNOTATION_PATH_VERIFICATION_MS) {
                BrowserLogger.warn('annotations', 'Slow staged annotation verification', {
                    totalMs,
                    knownSize,
                    timings,
                    rangeReadCount,
                    rangeReadBytes,
                    rangeReadTotalMs: roundAnnotationVerificationDuration(rangeReadTotalMs),
                    rangeReadMaxMs: roundAnnotationVerificationDuration(rangeReadMaxMs),
                    outcome,
                });
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
        const matchedRecords = new Set<IPdfAnnotationRecord>();
        const verificationPages = new Map<number, Promise<IVerificationPage>>();
        const preexistingPdfRefs = options.preexistingPdfAnnotationRefs === undefined
            ? null
            : new Set(options.preexistingPdfAnnotationRefs
                .map(value => normalizePdfJsAnnotationId(value))
                .filter((value): value is string => Boolean(value)));
        for (const expected of session.plan.expected) {
            if (expected.deleted && expected.pageIndex >= document.numPages) {
                continue;
            }
            const verificationPage = await this.#verificationPage(
                document,
                expected.pageIndex,
                verificationPages,
            );
            const {
                pageRotation,
                pageView,
                records,
            } = verificationPage;
            // The plan freezes expected content, not identity: bindings still
            // advance while the save runs (the managed-shape rescan of the
            // saved bytes learns each shape's ref before commit). The store
            // owns those bindings, so bind against it rather than the snapshot.
            const identity = this.store.get(expected.identity.id)?.identity ?? expected.identity;
            const externalIds = new Set([
                identity.id,
                identity.pdfRef,
                session.materializedPdfRefs.get(expected.identity.id),
            ].filter((value): value is string => Boolean(value)));
            if (expected.kind === 'note' && !identity.pdfRef) {
                const nativeName = getReplayableFreeTextNoteName({
                    stableKey: `ann:${expected.pageIndex}:${identity.id}`,
                    createdAt: expected.createdAt,
                });
                if (nativeName) externalIds.add(nativeName);
            }
            let record = records.find(candidate => !matchedRecords.has(candidate) && (
                (typeof candidate.id === 'string' && externalIds.has(candidate.id))
                || (typeof candidate.id === 'string' && externalIds.has(candidate.id.replace(/R0$/u, 'R')))
            ));
            if (
                !record
                && preexistingPdfRefs
                && expected.kind === 'note'
                && !identity.pdfRef
            ) {
                const semanticCandidates: IPdfAnnotationRecord[] = [];
                for (const candidate of records) {
                    if (matchedRecords.has(candidate) || candidate.subtype !== 'FreeText') {
                        continue;
                    }
                    const candidateRef = normalizePdfJsAnnotationId(candidate.id);
                    if (!candidateRef || preexistingPdfRefs.has(candidateRef)) {
                        continue;
                    }
                    const candidateRect = this.#normalizePdfRect(candidate.rect, pageView, pageRotation);
                    if (
                        !candidateRect
                        || Math.abs(candidateRect.left - expected.position.left) > 0.0001
                        || Math.abs(candidateRect.top - expected.position.top) > 0.0001
                        || Math.abs(candidateRect.width - expected.position.width) > 0.0001
                        || Math.abs(candidateRect.height - expected.position.height) > 0.0001
                    ) {
                        continue;
                    }
                    // The same text rule the comparison below applies, so a
                    // candidate can never be adopted and then rejected for text
                    // this match had read differently.
                    if (await verificationPage.resolveNoteText(candidate) !== expected.contents) {
                        continue;
                    }
                    semanticCandidates.push(candidate);
                }
                if (semanticCandidates.length === 1) {
                    [record] = semanticCandidates;
                }
            }
            if (record) {
                matchedRecords.add(record);
                if (
                    !identity.pdfRef
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
            if (expected.kind === 'note') {
                const rect = this.#normalizePdfRect(record.rect, pageView, pageRotation);
                reopened.push({
                    ...expected,
                    contents: await verificationPage.resolveNoteText(record),
                    ...(rect ? {position: rect} : {}),
                });
            } else if (expected.kind === 'text-markup') {
                const subtype = toMarkupSubtype(record.subtype);
                if (!subtype) continue;
                // Canonical geometry, not overlay geometry: the save verifier
                // compares what the file holds against what the store authored,
                // so both sides cross the same documented boundary.
                reopened.push({
                    ...expected,
                    subtype,
                    contents: await verificationPage.resolveNoteText(record),
                    quadPoints: toCanonicalTextMarkupGeometryFromRecord(record, pageView, pageRotation),
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
        this.store.markPersisted(
            session.frontier,
            this.#materializedPdfIdentityBindings(session),
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

    #normalizePdfRect(
        rect: readonly number[] | undefined,
        view: readonly number[],
        pageRotation: TPageRotation,
    ) {
        return toMarkerRectFromPdfRect(
            rect ? [...rect] : undefined,
            [...view],
            pageRotation,
        );
    }

    #materializedPdfIdentityBindings(session: IAnnotationSaveSession) {
        return Array.from(session.materializedPdfRefs, ([
            annotationId,
            pdfRef,
        ]) => ({
            annotationId,
            pdfRef,
        }));
    }

    /**
     * Reads one reopened page once and memoizes it, so several dirty
     * annotations on the same page share its records, its popup index and — at
     * most once, and only when some annotation actually carries `/Contents` —
     * its extracted text.
     */
    async #verificationPage(
        document: PDFDocumentProxy,
        pageIndex: number,
        cache: Map<number, Promise<IVerificationPage>>,
    ) {
        const cached = cache.get(pageIndex);
        if (cached) {
            return cached;
        }
        const loading = (async (): Promise<IVerificationPage> => {
            const page = await document.getPage(pageIndex + 1);
            const records = await page.getAnnotations() as IPdfAnnotationRecord[];
            const popupById = buildPopupIndex(records);
            const pageView = [...page.view];
            const pageRotation = normalizePageRotation(getOptionalNumber(page, 'rotate') ?? 0);
            let pageText: Promise<{
                items: IPdfTextPreviewItem[];
                viewport: IPdfTextPreviewViewport | null;
            }> | null = null;
            const readPageText = () => {
                pageText ??= (async () => {
                    try {
                        const viewport = page.getViewport({scale: 1});
                        const textContent = await page.getTextContent();
                        return {
                            items: Array.isArray(textContent.items)
                                ? textContent.items as IPdfTextPreviewItem[]
                                : [],
                            viewport: {
                                transform: [...viewport.transform],
                                width: viewport.width,
                                height: viewport.height,
                                scale: viewport.scale,
                            },
                        };
                    } catch (error) {
                        // The opened document falls back to no preview text the
                        // same way, so a page whose text will not extract still
                        // compares against the same answer on both sides.
                        BrowserLogger.debug(
                            'annotations',
                            `Failed to collect verification preview text for page ${pageIndex + 1}`,
                            error,
                        );
                        return {
                            items: [],
                            viewport: null,
                        };
                    }
                })();
                return pageText;
            };
            return {
                records,
                pageView,
                pageRotation,
                resolveNoteText: async (record) => {
                    const popup = record.popupRef
                        ? popupById.get(record.popupRef) ?? null
                        : null;
                    // Extracting page text is the expensive part, and it only
                    // changes the answer for text markup whose /Contents repeats
                    // the words underneath it. Notes and empty /Contents need
                    // none of it.
                    const mayRepeatPageText = isTextMarkupSubtype(record.subtype)
                        && resolveCombinedAnnotationText(record, popup).trim().length > 0;
                    const previewText = mayRepeatPageText
                        ? await readPageText().then(text => resolvePdfAnnotationPreviewText(
                            record,
                            text.items,
                            pageView,
                            pageRotation,
                            text.viewport,
                        ))
                        : null;
                    return normalizeAnnotationText(
                        resolvePdfAnnotationCommentText(record, popup, previewText),
                    );
                },
            };
        })();
        cache.set(pageIndex, loading);
        return loading;
    }
}
