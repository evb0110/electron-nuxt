import type {
    ComputedRef,
    InjectionKey,
} from 'vue';
import type { IContentInsets } from '@app/types/pdf';

export const pdfSkeletonContextKey: InjectionKey<{
    scaledSkeletonPadding: ComputedRef<IContentInsets | null>;
    scaledPageHeight: ComputedRef<number | null>;
}> = Symbol('PdfSkeletonContext');
