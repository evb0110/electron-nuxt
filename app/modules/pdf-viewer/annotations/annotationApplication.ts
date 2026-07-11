import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {IPageIdentityDelta} from '@contracts/electronApiPageOps';
import type {
    AnnotationEntity,
    AnnotationId,
    IShapeEntity,
    IStickyNoteEntity,
    ITextMarkupEntity,
    TAnnotationStyle,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import {
    deriveAnnotationId,
    asAnnotationId,
    mintAnnotationId,
    normalizeAnnotationText,
} from '@app/modules/pdf-viewer/annotations/domain/annotationEntity';
import {
    AnnotationStore,
    type IAnnotationSaveFrontier,
} from '@app/modules/pdf-viewer/annotations/domain/annotationStore';
import { ExternalIdentityConflictError } from '@app/modules/pdf-viewer/annotations/domain/externalIdentityIndex';
import {
    buildSerializationPlan,
    type IAnnotationReopenReader,
    verifyAnnotationSave,
} from '@app/modules/pdf-viewer/serialization/serializationPlan';

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
}

type TCreateStickyNote = Omit<IStickyNoteEntity, 'identity' | 'revision' | 'persistedRevision' | 'deleted'>;
type TCreateTextMarkup = Omit<ITextMarkupEntity, 'identity' | 'revision' | 'persistedRevision' | 'deleted'>;
type TCreateShape = Omit<IShapeEntity, 'identity' | 'revision' | 'persistedRevision' | 'deleted'>;

interface IPdfjsReopenedAnnotation {
    readonly id?: string;
    readonly annotationName?: string;
    readonly subtype?: string;
    readonly contents?: string;
    readonly contentsObj?: { readonly str?: string };
    readonly rect?: readonly number[];
}

function persistentIdentity(comment: IAnnotationCommentSummary) {
    return comment.annotationName
        ?? comment.annotationId
        ?? comment.uid
        ?? comment.id;
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
            const annotationId = comment.source === 'pdf'
                ? deriveAnnotationId(this.documentKey, persistentKey)
                : this.#mintedIds.get(persistentKey) ?? mintAnnotationId();
            if (comment.source !== 'pdf') this.#mintedIds.set(persistentKey, annotationId);
            const existing = this.store.get(annotationId);
            if (existing) {
                const identifiesSameRecord = Boolean(
                    (Boolean(comment.annotationId) && existing.identity.pdfRef === comment.annotationId)
                    || (Boolean(comment.uid) && existing.identity.pdfjsUid === comment.uid)
                    || (Boolean(comment.id) && existing.identity.elementId === comment.id),
                );
                if (!identifiesSameRecord) this.legacyIdentityConflicts.add(persistentIdentity(comment));
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
                persistedRevision: comment.source === 'pdf' ? 0 : -1,
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
                if (comment.source === 'pdf') this.store.import(entity);
                else this.store.createTextMarkup(entity);
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
            if (comment.source === 'pdf') this.store.import(entity);
            else this.store.createStickyNote(entity);
        });
    }

    ingestShapes(shapes: readonly IShapeAnnotation[]) {
        const present = new Set<AnnotationId>();
        shapes.forEach((shape) => {
            const persistentKey = shape.annotationId ?? shape.id;
            const annotationId = shape.source === 'embedded'
                ? deriveAnnotationId(this.documentKey, persistentKey)
                : this.#mintedIds.get(persistentKey) ?? mintAnnotationId();
            if (shape.source !== 'embedded') this.#mintedIds.set(persistentKey, annotationId);
            present.add(annotationId);
            const existing = this.store.get(annotationId);
            if (existing) {
                if (existing.kind === 'shape' && !existing.deleted && JSON.stringify(existing.geometry) !== JSON.stringify(shape)) {
                    // The shape executor has already registered the domain
                    // command with the shared history authority. Projection
                    // ingestion must not register a second undo entry.
                    this.store.import({
                        ...existing,
                        geometry: structuredClone(shape),
                        revision: existing.revision + 1,
                        modifiedAt: shape.modifiedAt ?? Date.now(),
                    });
                }
                return;
            }
            const entity = {
                kind: 'shape',
                identity: {
                    id: annotationId,
                    ...(shape.annotationId ? {pdfRef: shape.annotationId} : {}),
                    ...(shape.stableKey ? {pdfName: shape.stableKey.replace(/^nm:/u, '')} : {}),
                    ...(shape.id ? {elementId: shape.id} : {}),
                },
                pageIndex: shape.pageIndex,
                revision: 0,
                persistedRevision: shape.source === 'embedded' ? 0 : -1,
                deleted: false,
                createdAt: shape.createdAt ?? null,
                modifiedAt: shape.modifiedAt ?? null,
                author: null,
                geometry: structuredClone(shape),
            } as const;
            this.store.import(entity);
        });
        this.store.list().forEach((entity) => {
            if (entity.kind === 'shape' && !entity.deleted && !present.has(entity.identity.id)) {
                this.store.import({
                    ...entity,
                    deleted: true,
                    revision: entity.revision + 1,
                    modifiedAt: Date.now(),
                });
            }
        });
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

    createStickyNote(input: TCreateStickyNote) {
        return this.store.createStickyNote({
            ...input,
            identity: {id: mintAnnotationId()},
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        });
    }

    createTextMarkup(input: TCreateTextMarkup) {
        return this.store.createTextMarkup({
            ...input,
            identity: {id: mintAnnotationId()},
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        });
    }

    createShape(input: TCreateShape) {
        return this.store.createShape({
            ...input,
            identity: {id: mintAnnotationId()},
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        });
    }

    createShapeProjected(
        input: TCreateShape,
        project: (next: IShapeEntity | null, previous: IShapeEntity | null) => void,
    ) {
        return this.store.createShapeProjected({
            ...input,
            identity: {
                id: mintAnnotationId(),
                elementId: input.geometry.id,
            },
            revision: 0,
            persistedRevision: -1,
            deleted: false,
        }, (next, previous) => project(
            next?.kind === 'shape' ? next : null,
            previous?.kind === 'shape' ? previous : null,
        ));
    }

    annotationIdForShape(shape: Pick<IShapeAnnotation, 'id' | 'annotationId'>) {
        return this.store.resolveExternal({
            ...(shape.annotationId ? {pdfRef: shape.annotationId} : {}),
            elementId: shape.id,
        });
    }

    replaceShapeGeometryProjected(
        annotationId: AnnotationId,
        geometry: IShapeEntity['geometry'],
        project: (next: IShapeEntity | null, previous: IShapeEntity | null) => void,
        historyBeforeGeometry?: IShapeEntity['geometry'],
    ) {
        return this.store.replaceShapeGeometryProjected(
            annotationId,
            geometry,
            (next, previous) => project(
                next?.kind === 'shape' ? next : null,
                previous?.kind === 'shape' ? previous : null,
            ),
            historyBeforeGeometry,
        );
    }

    previewShapeGeometryProjected(
        annotationId: AnnotationId,
        geometry: IShapeEntity['geometry'],
        project: (next: IShapeEntity | null, previous: IShapeEntity | null) => void,
    ) {
        return this.store.previewShapeGeometryProjected(annotationId, geometry, (next, previous) => project(
            next?.kind === 'shape' ? next : null,
            previous?.kind === 'shape' ? previous : null,
        ));
    }

    deleteShapeProjected(
        annotationId: AnnotationId,
        project: (next: IShapeEntity | null, previous: IShapeEntity | null) => void,
    ) {
        return this.store.deleteProjected(annotationId, (next, previous) => project(
            next?.kind === 'shape' ? next : null,
            previous?.kind === 'shape' ? previous : null,
        ));
    }

    setNoteText(annotationId: AnnotationId, text: string) {
        return this.store.setNoteText(annotationId, text);
    }

    setStyle(annotationId: AnnotationId, style: TAnnotationStyle) {
        return this.store.setStyle(annotationId, style);
    }

    moveAnchor(annotationId: AnnotationId, anchor: IStickyNoteEntity['anchor']) {
        return this.store.moveAnchor(annotationId, anchor);
    }

    replaceShapeGeometry(annotationId: AnnotationId, geometry: IShapeEntity['geometry']) {
        return this.store.replaceShapeGeometry(annotationId, geometry);
    }

    delete(annotationId: AnnotationId) {
        return this.store.delete(annotationId);
    }

    restore(annotationId: AnnotationId) {
        return this.store.restore(annotationId);
    }

    remapPages(delta: IPageIdentityDelta) { this.store.remapPages(delta); }

    undo() { return this.store.undo(); }
    redo() { return this.store.redo(); }

    beginSave(documentRevisionToken: TDocumentRevisionToken | null = null): IAnnotationSaveSession {
        if (this.legacyIdentityConflicts.size) {
            throw new ExternalIdentityConflictError(`Ambiguous legacy annotation identities: ${Array.from(this.legacyIdentityConflicts).join(', ')}`);
        }
        const frontier = this.store.beginSave(documentRevisionToken);
        return {
            frontier,
            plan: buildSerializationPlan(
                frontier,
                this.store.dirtyAt(frontier),
                this.store.list({includeDeleted: true}),
            ),
        };
    }

    async verifyAndAcknowledgeSave(
        session: IAnnotationSaveSession,
        bytes: Uint8Array,
        reader: IAnnotationReopenReader,
    ) {
        await verifyAnnotationSave(bytes, session.plan, reader);
        this.store.acknowledgeSave(session.frontier);
    }

    async verifySaveBytes(session: IAnnotationSaveSession, bytes: Uint8Array) {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loadingTask = pdfjs.getDocument({data: bytes.slice()});
        const document = await loadingTask.promise;
        try {
            const reopened: AnnotationEntity[] = [];
            for (const expected of session.plan.expected) {
                const page = await document.getPage(expected.pageIndex + 1);
                const records: readonly IPdfjsReopenedAnnotation[] = await page.getAnnotations();
                const externalIds = new Set([
                    expected.identity.pdfRef,
                    expected.identity.pdfName,
                    expected.identity.pdfjsUid,
                    expected.identity.elementId,
                ].filter((value): value is string => Boolean(value)));
                const record = records.find(candidate => (
                    (typeof candidate.id === 'string' && externalIds.has(candidate.id))
                    || (typeof candidate.annotationName === 'string' && externalIds.has(candidate.annotationName))
                    || (typeof candidate.id === 'string' && externalIds.has(candidate.id.replace(/R0$/u, 'R')))
                ));
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
                    reopened.push({
                        ...expected,
                        subtype,
                        text: normalizeAnnotationText(record.contentsObj?.str ?? record.contents ?? ''),
                        ...(rect ? {geometry: [rect]} : {}),
                    });
                } else {
                    reopened.push(expected);
                }
            }
            await verifyAnnotationSave(bytes, session.plan, {reopen: () => Promise.resolve(reopened)});
        } finally {
            await document.destroy();
        }
    }

    acknowledgeSave(session: IAnnotationSaveSession) {
        this.store.acknowledgeSave(session.frontier);
    }

    assertSaveCurrent(session: IAnnotationSaveSession) {
        this.store.assertSaveFrontierCurrent(session.frontier);
    }

    #normalizePdfRect(rect: readonly number[] | undefined, view: readonly number[]) {
        if (!rect || rect.length < 4 || view.length < 4) {
            return null;
        }
        const [
            x1 = 0,
            y1 = 0,
            x2 = 0,
            y2 = 0,
        ] = rect;
        const [
            vx1 = 0,
            vy1 = 0,
            vx2 = 1,
            vy2 = 1,
        ] = view;
        const width = Math.abs(vx2 - vx1) || 1;
        const height = Math.abs(vy2 - vy1) || 1;
        return {
            left: (Math.min(x1, x2) - vx1) / width,
            top: (vy2 - Math.max(y1, y2)) / height,
            width: Math.abs(x2 - x1) / width,
            height: Math.abs(y2 - y1) / height,
        };
    }
}
