import type {
    IAnnotationMarkerRect,
    IShapeAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';

declare const annotationIdBrand: unique symbol;

// Domain language from the annotation blueprint intentionally omits the T prefix.
// eslint-disable-next-line @typescript-eslint/naming-convention
export type AnnotationId = string & { readonly [annotationIdBrand]: 'AnnotationId' };

export interface IAnnotationIdentity {
    readonly id: AnnotationId;
    readonly pdfRef?: string;
    readonly pdfName?: string;
    readonly pdfjsUid?: string;
    readonly elementId?: string;
}

interface IAnnotationFidelity {
    readonly subject?: string | null;
    readonly flags?: number | null;
    readonly rotation?: number | null;
    readonly zOrder?: number | null;
    readonly fontFamily?: string | null;
    readonly defaultAppearance?: string | null;
}

interface IAnnotationEntityBase {
    readonly identity: IAnnotationIdentity;
    readonly pageIndex: number;
    readonly revision: number;
    readonly persistedRevision: number;
    readonly deleted: boolean;
    readonly createdAt: number | null;
    readonly modifiedAt: number | null;
    readonly author: string | null;
    readonly fidelity?: IAnnotationFidelity;
}

export interface IStickyNoteEntity extends IAnnotationEntityBase {
    readonly kind: 'sticky-note';
    readonly text: string;
    readonly anchor: IAnnotationMarkerRect;
    readonly color: string | null;
}

export interface ITextMarkupEntity extends IAnnotationEntityBase {
    readonly kind: 'text-markup';
    readonly subtype: TMarkupSubtype;
    /**
     * The annotation's own note, never the document text under the selection.
     * Selection-created markup starts empty and stays empty until someone
     * writes a note; the selected words are derived for display and are never
     * serialized. A note stored in a linked popup rather than in `/Contents`
     * still belongs here, because that is the note the reader shows.
     */
    readonly text: string;
    readonly geometry: readonly IAnnotationMarkerRect[];
    readonly color: string | null;
    readonly opacity: number | null;
}

export interface IShapeEntity extends IAnnotationEntityBase {
    readonly kind: 'shape';
    readonly geometry: Readonly<IShapeAnnotation>;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
export type AnnotationEntity = IStickyNoteEntity | ITextMarkupEntity | IShapeEntity;

export type TAnnotationStyle =
    | {
        color: string | null;
        opacity?: number | null
    }
    | Pick<IShapeAnnotation, 'color' | 'fillColor' | 'opacity' | 'strokeWidth'>;

export interface IIdentityBindingEvent {
    readonly annotationId: AnnotationId;
    readonly expectedRevision: number;
    readonly bindings: Omit<IAnnotationIdentity, 'id'>;
}

export interface ISavedSemanticEntry {
    readonly kind: AnnotationEntity['kind'];
    readonly fingerprint: string;
}

export interface ITextMarkupOverlapCandidate {
    readonly annotationId: AnnotationId;
    readonly observedGeometry: readonly IAnnotationMarkerRect[];
}

export interface ITextMarkupSelectionProjection {
    readonly created: ITextMarkupEntity;
    readonly replacements: ReadonlyArray<{
        readonly annotationId: AnnotationId;
        readonly geometry: readonly IAnnotationMarkerRect[];
        readonly deleted: boolean;
    }>;
}

interface ITextMarkupReplacement {
    readonly before: ITextMarkupEntity;
    readonly after: ITextMarkupEntity;
}

export function asAnnotationId(value: string): AnnotationId {
    const normalized = value.trim();
    if (!normalized) throw new Error('AnnotationId must not be empty');
    return normalized as AnnotationId;
}

function fnv1a(value: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

export function deriveAnnotationId(documentKey: string, persistentIdentity: string): AnnotationId {
    return asAnnotationId(`anno_${fnv1a(`${documentKey}\u0000${persistentIdentity}`)}`);
}

export function mintAnnotationId(randomUuid = globalThis.crypto?.randomUUID?.bind(globalThis.crypto)): AnnotationId {
    if (!randomUuid) throw new Error('A cryptographically strong AnnotationId generator is required');
    return asAnnotationId(`anno_${randomUuid()}`);
}

export function normalizeAnnotationText(text: string) {
    return text.replace(/[\u200B\uFEFF]/gu, '');
}

export function semanticEntityFingerprint(entity: AnnotationEntity) {
    const {
        revision: _revision,
        persistedRevision: _persistedRevision,
        ...semanticEntity
    } = entity;
    return JSON.stringify(semanticEntity);
}

export function semanticSnapshot(entities: Iterable<AnnotationEntity>) {
    return new Map(Array.from(entities, entity => (
        [
            entity.identity.id,
            {
                kind: entity.kind,
                fingerprint: semanticEntityFingerprint(entity),
            },
        ] as const
    )));
}

export function snapshotOfKind(
    snapshot: ReadonlyMap<AnnotationId, ISavedSemanticEntry>,
    kind: AnnotationEntity['kind'] | undefined,
) {
    if (!kind) {
        return snapshot;
    }
    return new Map(Array.from(snapshot).filter(([
        , entry,
    ]) => entry.kind === kind));
}

export function saveFrontierEntityBaseline(entities: readonly AnnotationEntity[]) {
    return JSON.stringify(entities.map(entity => [
        entity.identity.id,
        entity.revision,
        entity.deleted,
        entity.pageIndex,
    ]));
}

export function remapSavedSemanticFingerprint(
    fingerprint: string,
    nextPageIndex: number | undefined,
) {
    const saved = JSON.parse(fingerprint) as Record<string, unknown>;
    if (nextPageIndex === undefined) {
        return JSON.stringify({
            ...saved,
            deleted: true,
        });
    }
    return JSON.stringify(saved.kind === 'shape'
        ? {
            ...saved,
            pageIndex: nextPageIndex,
            geometry: {
                ...(saved.geometry as Record<string, unknown>),
                pageIndex: nextPageIndex,
            },
        }
        : {
            ...saved,
            pageIndex: nextPageIndex,
        });
}

export function semanticSnapshotsEqual(
    left: ReadonlyMap<AnnotationId, ISavedSemanticEntry>,
    right: ReadonlyMap<AnnotationId, ISavedSemanticEntry>,
) {
    return left.size === right.size
        && Array.from(left).every(([
            id,
            entry,
        ]) => right.get(id)?.fingerprint === entry.fingerprint);
}

function subtractRect(
    source: IAnnotationMarkerRect,
    replacements: readonly IAnnotationMarkerRect[],
) {
    const intervals: Array<[number, number]> = [[
        source.left,
        source.left + source.width,
    ]];
    replacements.forEach((replacement) => {
        if (Math.min(source.top + source.height, replacement.top + replacement.height)
            <= Math.max(source.top, replacement.top)) {
            return;
        }
        const overlapLeft = Math.max(source.left, replacement.left);
        const overlapRight = Math.min(source.left + source.width, replacement.left + replacement.width);
        if (overlapRight <= overlapLeft) {
            return;
        }
        for (let index = intervals.length - 1; index >= 0; index -= 1) {
            const [
                left,
                right,
            ] = intervals[index]!;
            if (overlapRight <= left || overlapLeft >= right) {
                continue;
            }
            intervals.splice(index, 1);
            if (overlapRight < right) intervals.splice(index, 0, [
                overlapRight,
                right,
            ]);
            if (overlapLeft > left) intervals.splice(index, 0, [
                left,
                overlapLeft,
            ]);
        }
    });
    return intervals
        .filter(([
            left,
            right,
        ]) => right - left >= 0.0005)
        .map(([
            left,
            right,
        ]) => ({
            ...source,
            left,
            width: right - left,
        }));
}

function subtractGeometry(
    source: readonly IAnnotationMarkerRect[],
    replacements: readonly IAnnotationMarkerRect[],
) {
    return source.flatMap(rect => subtractRect(rect, replacements));
}

function geometryEqual(
    left: readonly IAnnotationMarkerRect[],
    right: readonly IAnnotationMarkerRect[],
) {
    return left.length === right.length && left.every((rect, index) => {
        const candidate = right[index];
        return candidate?.left === rect.left
            && candidate.top === rect.top
            && candidate.width === rect.width
            && candidate.height === rect.height;
    });
}

export function buildTextMarkupSelectionPlan(input: {
    created: ITextMarkupEntity;
    overlapCandidates: readonly ITextMarkupOverlapCandidate[];
    entities: readonly AnnotationEntity[];
}) {
    const byId = new Map(input.entities.map(entity => [
        entity.identity.id,
        entity,
    ]));
    const seen = new Set<AnnotationId>();
    const replacements: ITextMarkupReplacement[] = [];
    if (input.created.subtype !== 'Highlight') {
        input.overlapCandidates.forEach((candidate) => {
            if (seen.has(candidate.annotationId)) {
                return;
            }
            seen.add(candidate.annotationId);
            const current = byId.get(candidate.annotationId);
            if (!current
                || current.deleted
                || current.kind !== 'text-markup'
                || current.pageIndex !== input.created.pageIndex
                || current.subtype !== input.created.subtype) {
                return;
            }
            const geometry = subtractGeometry(candidate.observedGeometry, input.created.geometry);
            if (geometryEqual(geometry, candidate.observedGeometry)) {
                return;
            }
            replacements.push({
                before: current,
                after: {
                    ...current,
                    geometry,
                    deleted: geometry.length === 0,
                    revision: current.revision + 1,
                    modifiedAt: input.created.modifiedAt,
                },
            });
        });
    }
    return {
        replacements,
        projection: {
            created: structuredClone(input.created),
            replacements: replacements.map(({after}) => ({
                annotationId: after.identity.id,
                geometry: structuredClone(after.geometry),
                deleted: after.deleted,
            })),
        } satisfies ITextMarkupSelectionProjection,
    };
}
