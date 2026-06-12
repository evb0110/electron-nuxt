import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { mergeMarkerRects } from '@app/modules/pdf-viewer/engine/annotation-geometry/mergeMarkerRects';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import type { IDetachedCommentCluster } from '@app/modules/pdf-viewer/engine/annotations/annotation-marker-geometry/annotationMarkerGeometryTypes';

export function clusterDetachedComments(comments: IAnnotationCommentSummary[]) {
    const clusters: IDetachedCommentCluster[] = [];
    comments
        .slice()
        .sort((left, right) => {
            const leftRect = normalizeMarkerRect(left.markerRect);
            const rightRect = normalizeMarkerRect(right.markerRect);
            if (!leftRect || !rightRect) {
                return left.stableKey.localeCompare(right.stableKey);
            }
            if (leftRect.top !== rightRect.top) {
                return leftRect.top - rightRect.top;
            }
            if (leftRect.left !== rightRect.left) {
                return leftRect.left - rightRect.left;
            }
            return left.stableKey.localeCompare(right.stableKey);
        })
        .forEach((comment) => {
            const rect = normalizeMarkerRect(comment.markerRect);
            if (!rect) {
                return;
            }
            const candidate = clusters.find((cluster) => {
                const iou = markerRectIoU(cluster.anchorRect, rect);
                if (iou >= 0.22) {
                    return true;
                }
                const clusterCenterX = cluster.anchorRect.left + cluster.anchorRect.width / 2;
                const clusterCenterY = cluster.anchorRect.top + cluster.anchorRect.height / 2;
                const centerX = rect.left + rect.width / 2;
                const centerY = rect.top + rect.height / 2;
                const dx = Math.abs(clusterCenterX - centerX);
                const dy = Math.abs(clusterCenterY - centerY);
                return dx <= 0.028 && dy <= 0.028;
            });
            if (candidate) {
                candidate.comments.push(comment);
                candidate.anchorRect = mergeMarkerRects(candidate.anchorRect, rect);
                return;
            }
            clusters.push({
                anchorRect: rect,
                comments: [comment],
            });
        });
    return clusters;
}
