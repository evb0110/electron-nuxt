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
