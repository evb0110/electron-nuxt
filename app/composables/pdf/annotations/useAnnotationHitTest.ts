import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    ISpatialIndexEntry,
} from '@app/composables/pdf/annotations/types';
import { normalizeMarkerRect } from '@app/composables/pdf/annotations/useAnnotationGeometry';

interface IHitTestOptions {padding?: number;}

export function useAnnotationHitTest(
    annotationsRef: Ref<IAnnotationCommentSummary[]>,
) {
    const spatialIndex = ref<ISpatialIndexEntry[]>([]);

    function rebuildSpatialIndex(pageContainers: Map<number, HTMLElement>) {
        const entries: ISpatialIndexEntry[] = [];

        for (const annotation of annotationsRef.value) {
            const markerRect = normalizeMarkerRect(annotation.markerRect);
            if (!markerRect) {
                continue;
            }

            const container = pageContainers.get(annotation.pageNumber);
            if (!container) {
                continue;
            }

            const pageRect = container.getBoundingClientRect();
            if (pageRect.width <= 0 || pageRect.height <= 0) {
                continue;
            }

            entries.push({
                annotation,
                viewportRect: {
                    x: pageRect.left + markerRect.left * pageRect.width,
                    y: pageRect.top + markerRect.top * pageRect.height,
                    width: markerRect.width * pageRect.width,
                    height: markerRect.height * pageRect.height,
                },
                pageNumber: annotation.pageNumber,
            });
        }

        spatialIndex.value = entries;
    }

    function hitTest(
        viewportX: number,
        viewportY: number,
        options: IHitTestOptions = {},
    ): IAnnotationCommentSummary[] {
        const padding = options.padding ?? 4;
        const results: IAnnotationCommentSummary[] = [];

        for (const entry of spatialIndex.value) {
            const { viewportRect } = entry;
            if (
                viewportX >= viewportRect.x - padding
                && viewportX <= viewportRect.x + viewportRect.width + padding
                && viewportY >= viewportRect.y - padding
                && viewportY <= viewportRect.y + viewportRect.height + padding
            ) {
                results.push(entry.annotation);
            }
        }

        return results;
    }

    function hitTestNormalized(
        pageContainer: HTMLElement,
        normalizedX: number,
        normalizedY: number,
        pageNumber: number,
        options: IHitTestOptions = {},
    ): IAnnotationCommentSummary[] {
        const padding = options.padding ?? 0.015;
        const results: IAnnotationCommentSummary[] = [];

        for (const annotation of annotationsRef.value) {
            if (annotation.pageNumber !== pageNumber) {
                continue;
            }
            const rect = normalizeMarkerRect(annotation.markerRect);
            if (!rect) {
                continue;
            }

            if (
                normalizedX >= rect.left - padding
                && normalizedX <= rect.left + rect.width + padding
                && normalizedY >= rect.top - padding
                && normalizedY <= rect.top + rect.height + padding
            ) {
                results.push(annotation);
            }
        }

        return results;
    }

    function findClosestAnnotation(
        viewportX: number,
        viewportY: number,
        maxDistance: number = Number.POSITIVE_INFINITY,
    ): IAnnotationCommentSummary | null {
        let best: {
            annotation: IAnnotationCommentSummary;
            distance: number 
        } | null = null;

        for (const entry of spatialIndex.value) {
            const { viewportRect } = entry;
            const centerX = viewportRect.x + viewportRect.width / 2;
            const centerY = viewportRect.y + viewportRect.height / 2;
            const distance = Math.hypot(viewportX - centerX, viewportY - centerY);

            if (distance <= maxDistance && (!best || distance < best.distance)) {
                best = {
                    annotation: entry.annotation,
                    distance, 
                };
            }
        }

        return best?.annotation ?? null;
    }

    return {
        spatialIndex,
        rebuildSpatialIndex,
        hitTest,
        hitTestNormalized,
        findClosestAnnotation,
    };
}
