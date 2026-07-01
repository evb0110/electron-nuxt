import type { Ref } from 'vue';

const DEFAULT_FALLBACK_WIDTH_PX = 960;
const DEFAULT_FALLBACK_HEIGHT_PX = 720;
const DEFAULT_MIN_WIDTH_PX = 320;
const DEFAULT_MIN_HEIGHT_PX = 420;
const DEFAULT_ASPECT_RATIO = 4 / 3;

interface IInitialSurfacePlaceholderLayoutOptions {
    containerWidth: Ref<number>;
    containerHeight: Ref<number>;
    horizontalMargin: number;
    fallbackWidth?: number;
    fallbackHeight?: number;
    minWidth?: number;
    minHeight?: number;
    aspectRatio?: number;
}

export const useInitialSurfacePlaceholderLayout = (options: IInitialSurfacePlaceholderLayoutOptions) => {
    const pageSize = computed(() => {
        const fallbackWidth = options.fallbackWidth ?? DEFAULT_FALLBACK_WIDTH_PX;
        const fallbackHeight = options.fallbackHeight ?? DEFAULT_FALLBACK_HEIGHT_PX;
        const hostWidth = options.containerWidth.value || fallbackWidth;
        const hostHeight = options.containerHeight.value || fallbackHeight;
        const width = Math.max(
            options.minWidth ?? DEFAULT_MIN_WIDTH_PX,
            Math.min(
                hostWidth - options.horizontalMargin * 2,
                fallbackWidth,
            ),
        );
        const height = Math.max(
            options.minHeight ?? DEFAULT_MIN_HEIGHT_PX,
            Math.min(
                hostHeight - options.horizontalMargin * 2,
                width / (options.aspectRatio ?? DEFAULT_ASPECT_RATIO),
            ),
        );

        return {
            width: Math.round(width),
            height: Math.round(height),
        };
    });

    return { pageSize };
};
