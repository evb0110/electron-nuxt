import type { Ref } from 'vue';
import { clamp } from 'es-toolkit/math';
import {
    computeInitialImagePlacementDimensions,
    type IImagePlacementDimensions,
} from '@app/composables/pdf/pdfImagePlacementSizing';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
    IPdfPlacedImageFinalizePayload,
} from '@app/types/pdf-image-placement';

interface IUsePdfImagePlacementOptions {
    viewerContainer: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    numPages: Ref<number>;
    effectiveScale: Ref<number>;
    emitFinalize: (payload: IPdfPlacedImageFinalizePayload) => void;
}

export interface IImagePlacementTarget {
    pageNumber: number;
    pageX: number;
    pageY: number;
    pageWidthPx: number | null;
    pageHeightPx: number | null;
}

function resolveDevicePixelRatio() {
    return typeof window !== 'undefined' && window.devicePixelRatio > 0
        ? window.devicePixelRatio
        : 1;
}

const MIN_PLACED_IMAGE_TARGET_LONG_EDGE_PX = 64;
const MIN_PLACED_IMAGE_TARGET_SHORT_EDGE_PX = 16;

export function getInitialImagePlacementRect(
    target: IImagePlacementTarget,
    dimensions: IImagePlacementDimensions,
) {
    const x = clamp(target.pageX - (dimensions.width / 2), 0, Math.max(0, 1 - dimensions.width));
    const y = clamp(target.pageY - (dimensions.height / 2), 0, Math.max(0, 1 - dimensions.height));

    return {
        pageNumber: target.pageNumber,
        x,
        y,
        width: dimensions.width,
        height: dimensions.height,
    };
}

function resolvePlacedImageTargetPixels(options: {
    width: number;
    height: number;
}) {
    const requestedWidth = Math.max(1, Math.round(options.width));
    const requestedHeight = Math.max(1, Math.round(options.height));
    const longEdge = Math.max(requestedWidth, requestedHeight);
    const shortEdge = Math.min(requestedWidth, requestedHeight);
    const scaleFactor = Math.max(
        1,
        MIN_PLACED_IMAGE_TARGET_LONG_EDGE_PX / longEdge,
        MIN_PLACED_IMAGE_TARGET_SHORT_EDGE_PX / shortEdge,
    );

    return {
        width: Math.max(1, Math.round(requestedWidth * scaleFactor)),
        height: Math.max(1, Math.round(requestedHeight * scaleFactor)),
    };
}

async function getImageIntrinsicSize(file: File) {
    if (typeof createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        try {
            return {
                width: bitmap.width,
                height: bitmap.height,
            };
        } finally {
            bitmap.close();
        }
    }

    const imageUrl = URL.createObjectURL(file);
    try {
        const dimensions = await new Promise<{
            width: number;
            height: number;
        }>((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                resolve({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                });
            };
            image.onerror = () => {
                reject(new Error('Failed to decode image dimensions'));
            };
            image.src = imageUrl;
        });
        return dimensions;
    } finally {
        URL.revokeObjectURL(imageUrl);
    }
}

async function getInitialImagePlacementDimensions(
    file: File,
    pageWidthPx: number | null,
    pageHeightPx: number | null,
) {
    if (
        !pageWidthPx
        || !pageHeightPx
        || pageWidthPx <= 0
        || pageHeightPx <= 0
    ) {
        return null;
    }

    const {
        width: imageWidth,
        height: imageHeight,
    } = await getImageIntrinsicSize(file);
    if (imageWidth <= 0 || imageHeight <= 0) {
        return null;
    }

    const devicePixelRatioValue = resolveDevicePixelRatio();
    const imageCssWidth = imageWidth / devicePixelRatioValue;
    const imageCssHeight = imageHeight / devicePixelRatioValue;
    return computeInitialImagePlacementDimensions({
        pageWidthPx,
        pageHeightPx,
        imageCssWidth,
        imageCssHeight,
    });
}

export function usePdfImagePlacement(options: IUsePdfImagePlacementOptions) {
    const {
        viewerContainer,
        currentPage,
        numPages,
        effectiveScale,
        emitFinalize,
    } = options;

    const pendingImagePlacement = ref<IPdfImagePlacementDraft | null>(null);
    const isPendingImagePlacementFinalizing = ref(false);

    function revokePendingImagePlacementPreview() {
        const previewUrl = pendingImagePlacement.value?.previewUrl;
        if (previewUrl) {
            URL.revokeObjectURL(previewUrl);
        }
    }

    function clearPendingImagePlacement() {
        revokePendingImagePlacementPreview();
        pendingImagePlacement.value = null;
        isPendingImagePlacementFinalizing.value = false;
    }

    function restorePendingImagePlacement() {
        if (!pendingImagePlacement.value) {
            return;
        }
        isPendingImagePlacementFinalizing.value = false;
    }

    function getImagePlacementTarget(optionsOverride?: {
        pageNumber?: number | null;
        pageX?: number | null;
        pageY?: number | null;
    }): IImagePlacementTarget {
        const container = viewerContainer.value;
        const requestedPageNumber = Number.isFinite(optionsOverride?.pageNumber)
            ? Math.max(1, Math.min(numPages.value, Math.floor(Number(optionsOverride?.pageNumber))))
            : currentPage.value;
        const pageNumber = Math.max(1, requestedPageNumber);
        const pageContainer = container?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        ) ?? null;
        const pageRect = pageContainer?.getBoundingClientRect() ?? null;
        const pageX = Number.isFinite(optionsOverride?.pageX) ? Number(optionsOverride?.pageX) : 0.5;
        const pageY = Number.isFinite(optionsOverride?.pageY) ? Number(optionsOverride?.pageY) : 0.5;

        return {
            pageNumber,
            pageX: clamp(pageX, 0, 1),
            pageY: clamp(pageY, 0, 1),
            pageWidthPx: pageRect?.width ?? null,
            pageHeightPx: pageRect?.height ?? null,
        };
    }

    async function startImagePlacement(
        file: File,
        optionsOverride?: {
            pageNumber?: number | null;
            pageX?: number | null;
            pageY?: number | null;
        },
    ) {
        const target = getImagePlacementTarget(optionsOverride);
        let initialDimensions: IImagePlacementDimensions | null;
        try {
            initialDimensions = await getInitialImagePlacementDimensions(
                file,
                target.pageWidthPx,
                target.pageHeightPx,
            );
        } catch {
            return false;
        }
        if (!initialDimensions) {
            return false;
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        const previewUrl = URL.createObjectURL(new Blob([bytes], { type: file.type || 'image/png' }));
        const placementRect = getInitialImagePlacementRect(target, initialDimensions);

        clearPendingImagePlacement();
        pendingImagePlacement.value = {
            ...placementRect,
            rotationDegrees: 0,
            previewUrl,
            fileName: file.name,
            mimeType: file.type || 'image/png',
            bytes,
        };
        isPendingImagePlacementFinalizing.value = false;
        return true;
    }

    function updatePendingImagePlacementRect(update: IPdfImagePlacementRectUpdate) {
        if (!pendingImagePlacement.value) {
            return;
        }

        pendingImagePlacement.value = {
            ...pendingImagePlacement.value,
            ...update,
        };
    }

    function getPendingImagePlacementTargetPixels(placement: IPdfImagePlacementDraft) {
        const pageContainer = viewerContainer.value?.querySelector<HTMLElement>(
            `.page_container[data-page="${placement.pageNumber}"]`,
        ) ?? null;
        const canvas = pageContainer?.querySelector<HTMLCanvasElement>('.page_canvas canvas') ?? null;
        const devicePixelRatioValue = resolveDevicePixelRatio();
        const renderedPagePixelWidth = canvas?.width
            ?? Math.max(1, Math.round((pageContainer?.clientWidth ?? 1) * devicePixelRatioValue));
        const renderedPagePixelHeight = canvas?.height
            ?? Math.max(1, Math.round((pageContainer?.clientHeight ?? 1) * devicePixelRatioValue));
        const renderScale = effectiveScale.value > 0 ? effectiveScale.value : 1;
        const basePagePixelWidth = Math.max(1, Math.round(renderedPagePixelWidth / renderScale));
        const basePagePixelHeight = Math.max(1, Math.round(renderedPagePixelHeight / renderScale));

        return resolvePlacedImageTargetPixels({
            width: placement.width * basePagePixelWidth,
            height: placement.height * basePagePixelHeight,
        });
    }

    function requestPendingImagePlacementFinalize() {
        const placement = pendingImagePlacement.value;
        if (!placement || isPendingImagePlacementFinalizing.value) {
            return;
        }

        const targetPixels = getPendingImagePlacementTargetPixels(placement);
        isPendingImagePlacementFinalizing.value = true;
        emitFinalize({
            pageNumber: placement.pageNumber,
            x: placement.x,
            y: placement.y,
            width: placement.width,
            height: placement.height,
            rotationDegrees: placement.rotationDegrees,
            fileName: placement.fileName,
            mimeType: placement.mimeType,
            bytes: placement.bytes.slice(),
            targetPixelWidth: targetPixels.width,
            targetPixelHeight: targetPixels.height,
        });
    }

    onScopeDispose(() => {
        clearPendingImagePlacement();
    });

    return {
        pendingImagePlacement,
        isPendingImagePlacementFinalizing,
        startImagePlacement,
        updatePendingImagePlacementRect,
        requestPendingImagePlacementFinalize,
        clearPendingImagePlacement,
        restorePendingImagePlacement,
    };
}
