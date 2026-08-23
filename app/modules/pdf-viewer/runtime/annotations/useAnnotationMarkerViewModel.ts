import type { Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import {
    groupBy,
    maxBy,
} from 'es-toolkit/array';
import { clamp } from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IMarkerViewModel } from '@app/modules/pdf-viewer/engine/annotations/types';
import { clusterDetachedComments } from '@app/modules/pdf-viewer/engine/annotations/annotation-marker-geometry/clusterDetachedComments';
import { resolveDetachedMarkerPlacement } from '@app/modules/pdf-viewer/engine/annotations/annotation-marker-geometry/resolveDetachedMarkerPlacement';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import type { IDetachedMarkerOccupied } from '@app/modules/pdf-viewer/engine/annotations/annotation-marker-geometry/annotationMarkerGeometryTypes';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/engine/annotations/domain/annotationSummaryIdentity';
import { isPointNoteMarkerSizedRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/pointNoteMarkerPolicy';

interface IUseAnnotationMarkerViewModelOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    markerGeometryVersion?: Ref<number> | undefined;
    labels: {
        annotation: string;
        note: string;
        moreNotes: (count: number) => string;
    };
}

function buildPreview(
    comment: IAnnotationCommentSummary,
    labels: IUseAnnotationMarkerViewModelOptions['labels'],
) {
    const text = comment.text?.trim();
    if (!text) {
        return comment.kindLabel ?? comment.subtype ?? labels.note;
    }
    return text.length > 60 ? text.slice(0, 57) + '...' : text;
}

function buildAriaLabel(
    comment: IAnnotationCommentSummary,
    clusterSize: number,
    labels: IUseAnnotationMarkerViewModelOptions['labels'],
) {
    const prefix = comment.kindLabel ?? comment.subtype ?? labels.annotation;
    const preview = comment.text?.trim().slice(0, 40) ?? '';
    const label = preview ? `${prefix}: ${preview}` : prefix;
    if (clusterSize > 1) {
        return `${label} (${labels.moreNotes(clusterSize - 1)})`;
    }
    return label;
}

function pickPrimaryComment(
    comments: IAnnotationCommentSummary[],
    activeKey: string | null,
): IAnnotationCommentSummary {
    if (activeKey) {
        const active = comments.find(comment => annotationIdForSummary(comment) === activeKey);
        if (active) {
            return active;
        }
    }
    return maxBy(comments, comment => comment.modifiedAt ?? 0)!;
}

function isMarkerEligibleComment(comment: IAnnotationCommentSummary) {
    if (comment.hasNote !== true) {
        return false;
    }

    const rect = normalizeMarkerRect(comment.markerRect);
    if (!rect) {
        return false;
    }

    const subtype = (comment.subtype ?? '').trim().toLowerCase();
    if (subtype === 'freetext' || subtype === 'typewriter') {
        // Regular text annotations are also FreeText/Typewriter, but sticky notes
        // use a point-like anchor rect. Keep markers only for that anchor shape.
        return isPointNoteMarkerSizedRect(rect);
    }

    return true;
}

function computeMarkersByPage(
    comments: IAnnotationCommentSummary[],
    activeKey: string | null,
    viewerContainer: HTMLElement | null,
    labels: IUseAnnotationMarkerViewModelOptions['labels'],
): Map<number, IMarkerViewModel[]> {
    const result = new Map<number, IMarkerViewModel[]>();
    const withRect = comments.filter(isMarkerEligibleComment);

    if (withRect.length === 0) {
        return result;
    }

    const byPage = groupBy(withRect, comment => comment.pageNumber);

    for (const [
        pageNumberKey,
        pageComments,
    ] of Object.entries(byPage)) {
        const pageNumber = Number(pageNumberKey);
        const typedPageComments = pageComments;
        const clusters = clusterDetachedComments(typedPageComments);
        const occupied: IDetachedMarkerOccupied[] = [];
        const markers: IMarkerViewModel[] = [];
        const pageContainer = viewerContainer?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        );

        for (const cluster of clusters) {
            const primary = pickPrimaryComment(cluster.comments, activeKey);
            const rect = normalizeMarkerRect(primary.markerRect);
            if (!rect) {
                continue;
            }

            let leftPercent: number;
            let topPercent: number;

            if (pageContainer) {
                const placement = resolveDetachedMarkerPlacement(
                    pageContainer,
                    rect,
                    occupied,
                );
                leftPercent = placement.leftPercent;
                topPercent = placement.topPercent;
            }
            else {
                leftPercent = clamp((rect.left + rect.width) * 100, 1, 99);
                topPercent = clamp(rect.top * 100, 1, 99);
            }

            markers.push({
                annotation: primary,
                clustered: cluster.comments,
                leftPercent,
                topPercent,
                isActive: cluster.comments.some(comment => annotationIdForSummary(comment) === activeKey),
                preview: buildPreview(primary, labels),
                ariaLabel: buildAriaLabel(primary, cluster.comments.length, labels),
            });
        }

        if (markers.length > 0) {
            result.set(pageNumber, markers);
        }
    }

    return result;
}

export const useAnnotationMarkerViewModel = (options: IUseAnnotationMarkerViewModelOptions) => {
    const {
        viewerContainer,
        annotationCommentsCache,
        activeCommentStableKey,
        markerGeometryVersion,
        labels,
    } = options;

    const markersByPage = shallowRef<Map<number, IMarkerViewModel[]>>(new Map());

    const recompute = () => {
        markersByPage.value = computeMarkersByPage(
            annotationCommentsCache.value,
            activeCommentStableKey.value,
            viewerContainer.value,
            labels,
        );
    };

    watch(
        [
            annotationCommentsCache,
            activeCommentStableKey,
            ...(markerGeometryVersion ? [markerGeometryVersion] : []),
        ],
        recompute,
        { immediate: true },
    );

    function syncInlineCommentIndicators() {
        recompute();
    }

    const {
        start: debouncedSyncInlineCommentIndicators,
        stop: cancelDebouncedSyncInlineCommentIndicators,
    } = useTimeoutFn(syncInlineCommentIndicators, 70, { immediate: false });

    const {
        start: startPulseCleanup,
        stop: stopPulseCleanup,
    } = useTimeoutFn(() => {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }
        const pulsing = container.querySelectorAll('.pdf-comment-focus-pulse');
        pulsing.forEach(el => el.classList.remove('pdf-comment-focus-pulse'));
    }, FOCUS_PULSE_MS, { immediate: false });

    function pulseCommentIndicator(stableKey: string) {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }

        stopPulseCleanup();
        const pulsing = container.querySelectorAll('.pdf-comment-focus-pulse');
        pulsing.forEach(el => el.classList.remove('pdf-comment-focus-pulse'));

        const marker = container.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${CSS.escape(stableKey)}"]`,
        );
        if (marker) {
            marker.classList.add('pdf-comment-focus-pulse');
            startPulseCleanup();
        }
    }

    function resolveCommentFromIndicatorElement(element: HTMLElement): IAnnotationCommentSummary | null {
        const stableKey = element.closest<HTMLElement>('[data-stable-key]')?.dataset.stableKey;
        if (!stableKey) {
            return null;
        }
        return annotationCommentsCache.value.find(c => c.stableKey === stableKey) ?? null;
    }

    function findCommentFromInlineTarget(target: HTMLElement): IAnnotationCommentSummary | null {
        const markerButton = target.closest<HTMLElement>('.pdf-comment-marker-button');
        if (markerButton) {
            return resolveCommentFromIndicatorElement(markerButton);
        }
        return null;
    }

    function cleanup() {
        stopPulseCleanup();
        cancelDebouncedSyncInlineCommentIndicators();
    }

    return {
        markersByPage: markersByPage as Readonly<Ref<Map<number, IMarkerViewModel[]>>>,
        inlineIndicators: {
            syncInlineCommentIndicators,
            debouncedSyncInlineCommentIndicators,
            pulseCommentIndicator,
            resolveCommentFromIndicatorElement,
            findCommentFromInlineTarget,
            attachInlineCommentMarkerObserver: () => {},
            cleanup,
        },
    };
};
