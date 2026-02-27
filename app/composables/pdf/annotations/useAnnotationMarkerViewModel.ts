import type { Ref } from 'vue';
import { debounce } from 'es-toolkit/function';
import { clamp } from 'es-toolkit/math';
import type {
    IAnnotationCommentSummary,
    IMarkerViewModel,
} from '@app/composables/pdf/annotations/types';
import {
    normalizeMarkerRect,
    clusterDetachedComments,
    resolveDetachedMarkerPlacement,
} from '@app/composables/pdf/annotations/useAnnotationGeometry';
import type { IDetachedMarkerOccupied } from '@app/composables/pdf/annotations/useAnnotationGeometry';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';

interface IUseAnnotationMarkerViewModelOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
}

function buildPreview(comment: IAnnotationCommentSummary): string {
    const text = comment.text?.trim();
    if (!text) {
        return comment.kindLabel ?? comment.subtype ?? 'Note';
    }
    return text.length > 60 ? text.slice(0, 57) + '...' : text;
}

function buildAriaLabel(comment: IAnnotationCommentSummary, clusterSize: number): string {
    const prefix = comment.kindLabel ?? comment.subtype ?? 'Annotation';
    const preview = comment.text?.trim().slice(0, 40) || '';
    const label = preview ? `${prefix}: ${preview}` : prefix;
    if (clusterSize > 1) {
        return `${label} (+${clusterSize - 1} more)`;
    }
    return label;
}

function pickPrimaryComment(
    comments: IAnnotationCommentSummary[],
    activeKey: string | null,
): IAnnotationCommentSummary {
    if (activeKey) {
        const active = comments.find(c => c.stableKey === activeKey);
        if (active) {
            return active;
        }
    }
    return comments
        .slice()
        .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))[0]!;
}

function computeMarkersByPage(
    comments: IAnnotationCommentSummary[],
    activeKey: string | null,
    viewerContainer: HTMLElement | null,
): Map<number, IMarkerViewModel[]> {
    const result = new Map<number, IMarkerViewModel[]>();
    const withRect = comments.filter(c => normalizeMarkerRect(c.markerRect) !== null);

    if (withRect.length === 0) {
        return result;
    }

    const byPage = new Map<number, IAnnotationCommentSummary[]>();
    for (const comment of withRect) {
        const page = comment.pageNumber;
        let arr = byPage.get(page);
        if (!arr) {
            arr = [];
            byPage.set(page, arr);
        }
        arr.push(comment);
    }

    for (const [
        pageNumber,
        pageComments,
    ] of byPage) {
        const clusters = clusterDetachedComments(pageComments);
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
                isActive: cluster.comments.some(c => c.stableKey === activeKey),
                preview: buildPreview(primary),
                ariaLabel: buildAriaLabel(primary, cluster.comments.length),
            });
        }

        if (markers.length > 0) {
            result.set(pageNumber, markers);
        }
    }

    return result;
}

export function useAnnotationMarkerViewModel(options: IUseAnnotationMarkerViewModelOptions) {
    const {
        viewerContainer,
        annotationCommentsCache,
        activeCommentStableKey,
    } = options;

    const markersByPage = shallowRef<Map<number, IMarkerViewModel[]>>(new Map());

    const recompute = () => {
        markersByPage.value = computeMarkersByPage(
            annotationCommentsCache.value,
            activeCommentStableKey.value,
            viewerContainer.value,
        );
    };

    watch(
        [
            annotationCommentsCache,
            activeCommentStableKey,
        ],
        recompute,
        { immediate: true },
    );

    function syncInlineCommentIndicators() {
        recompute();
    }

    const debouncedSyncInlineCommentIndicators = debounce(
        syncInlineCommentIndicators,
        70,
    );

    let pulseTimer: ReturnType<typeof setTimeout> | null = null;

    function pulseCommentIndicator(stableKey: string) {
        const container = viewerContainer.value;
        if (!container) {
            return;
        }

        if (pulseTimer !== null) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
        }

        const pulsing = container.querySelectorAll('.pdf-comment-focus-pulse');
        pulsing.forEach(el => el.classList.remove('pdf-comment-focus-pulse'));

        const marker = container.querySelector<HTMLElement>(
            `.pdf-comment-marker-button[data-stable-key="${CSS.escape(stableKey)}"]`,
        );
        if (marker) {
            marker.classList.add('pdf-comment-focus-pulse');
            pulseTimer = setTimeout(() => {
                marker.classList.remove('pdf-comment-focus-pulse');
                pulseTimer = null;
            }, FOCUS_PULSE_MS);
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
        if (pulseTimer !== null) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
        }
        debouncedSyncInlineCommentIndicators.cancel();
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
}
