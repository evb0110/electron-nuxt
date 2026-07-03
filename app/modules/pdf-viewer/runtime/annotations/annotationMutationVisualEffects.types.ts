import type { Ref } from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';

export type TAnnotationMutationVisualEffectKind =
    | 'text-markup-color'
    | 'annotation-dom-removal'
    | 'render-page-text-markup';

export interface IAnnotationMutationVisualEffect {
    id: number;
    kind: TAnnotationMutationVisualEffectKind;
    stableKey?: string | null;
    annotationId?: string | null;
    pageNumber?: number | null;
    commentSnapshot?: IAnnotationCommentSummary | null;
    color?: string | null;
    sourceColor?: string | null;
}

export interface IAnnotationMutationVisualEffectsState {
    version: Ref<number>;
    effects: Readonly<Ref<readonly IAnnotationMutationVisualEffect[]>>;
    enqueue(effect: Omit<IAnnotationMutationVisualEffect, 'id'>): void;
    consumeThrough(id: number): void;
}
