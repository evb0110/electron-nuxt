import type {
    MaybeRefOrGetter,
    InjectionKey,
    ComputedRef,
} from 'vue';
import type {
    IContentInsets,
    PDFPageProxy,
} from '@app/types/pdf';
import { clamp } from 'es-toolkit/math';

interface IPdfSkeletonContext {
    scaledSkeletonPadding: ComputedRef<IContentInsets | null>;
    scaledPageHeight: ComputedRef<number | null>;
}

const PDF_SKELETON_CONTEXT_KEY: InjectionKey<IPdfSkeletonContext> = Symbol('PdfSkeletonContext');

export const usePdfSkeletonContext = () => {
    const context = inject<IPdfSkeletonContext>(PDF_SKELETON_CONTEXT_KEY);
    if (!context) {
        throw new Error('usePdfSkeletonContext must be used within a component that calls usePdfSkeletonInsets');
    }
    return context;
};

export const usePdfSkeletonInsets = (
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
    effectiveScale: MaybeRefOrGetter<number>,
) => {
    const skeletonContentInsets = ref<IContentInsets | null>(null);

    const scaledSkeletonPadding = computed<IContentInsets | null>(() => {
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            return null;
        }

        const insets = skeletonContentInsets.value ?? buildFallbackInsets(width, height);
        const scale = toValue(effectiveScale);

        return {
            top: insets.top * scale,
            right: insets.right * scale,
            bottom: insets.bottom * scale,
            left: insets.left * scale,
        };
    });

    const scaledPageHeight = computed(() => {
        const height = toValue(basePageHeight);
        if (!height) {
            return null;
        }
        return Math.floor(height * toValue(effectiveScale));
    });

    provide(PDF_SKELETON_CONTEXT_KEY, {
        scaledSkeletonPadding,
        scaledPageHeight,
    });

    function buildFallbackInsets(width: number, height: number): IContentInsets {
        const horizontal = clamp(width * 0.08, 24, width / 3);
        const vertical = clamp(height * 0.1, 32, height / 3);

        return {
            top: vertical,
            right: horizontal,
            bottom: vertical,
            left: horizontal,
        };
    }

    function computeSkeletonInsets(
        pdfPage: PDFPageProxy,
        renderVersion: number,
        getCurrentVersion: () => number,
    ): Promise<void> {
        void pdfPage;
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!width || !height) {
            skeletonContentInsets.value = null;
            return Promise.resolve();
        }

        if (getCurrentVersion() !== renderVersion) {
            return Promise.resolve();
        }

        skeletonContentInsets.value = buildFallbackInsets(width, height);
        return Promise.resolve();
    }

    function resetInsets() {
        skeletonContentInsets.value = null;
    }

    return {
        skeletonContentInsets,
        scaledSkeletonPadding,
        scaledPageHeight,
        computeSkeletonInsets,
        resetInsets,
    };
};
