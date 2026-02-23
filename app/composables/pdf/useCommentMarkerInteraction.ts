import type { Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import { uniq } from 'es-toolkit/array';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import {
    escapeCssAttr,
    commentPreviewText,
    normalizeMarkerRect,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/pdfAnnotationUtils';
import type { useAnnotationCommentIdentity } from '@app/composables/pdf/useAnnotationCommentIdentity';
import { FOCUS_PULSE_MS } from '@app/constants/timeouts';

type TIdentity = ReturnType<typeof useAnnotationCommentIdentity>;

interface ICommentMarkerInteractionDeps {
    viewerContainer: Ref<HTMLElement | null>;
    activeCommentStableKey: Ref<string | null>;
    setActiveCommentStableKey: (stableKey: string | null) => void;
    identity: TIdentity;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    buildAnnotationContextMenuPayload: (comment: IAnnotationCommentSummary | null, clientX: number, clientY: number) => IAnnotationContextMenuPayload;
    parseStableKeysAttr: (value: string | null | undefined) => string[];
    serializeStableKeysAttr: (keys: string[]) => string;
    pickBestCommentFromStableKeys: (stableKeys: string[]) => IAnnotationCommentSummary | null;
    getAnnotationComments: () => IAnnotationCommentSummary[];
    getInlineTargetStableKeys: (target: HTMLElement) => string[];
    markerIncludesStableKey: (marker: HTMLElement, stableKey: string) => boolean;
    isCommentActive: (stableKey: string) => boolean;
}

export const useCommentMarkerInteraction = (deps: ICommentMarkerInteractionDeps) => {
    const { t } = useTypedI18n();
    const {
        start: startInlineCommentFocusPulseTimeout,
        stop: stopInlineCommentFocusPulseTimeout,
    } = useTimeoutFn(() => {
        const container = deps.viewerContainer.value;
        if (!container) {
            return;
        }
        container.querySelectorAll<HTMLElement>('.pdf-comment-focus-pulse').forEach((element) => {
            element.classList.remove('pdf-comment-focus-pulse');
        });
    }, FOCUS_PULSE_MS, { immediate: false });

    function clearTransientSelectionVisuals() {
        const root = deps.viewerContainer.value ?? document;
        root.querySelectorAll<HTMLElement>(
            '.annotationEditorLayer .highlightEditor.selectedEditor, .annotation-editor-layer .highlightEditor.selectedEditor, .annotationEditorLayer .highlightEditor.selected, .annotation-editor-layer .highlightEditor.selected',
        ).forEach((element) => {
            element.classList.remove('selectedEditor', 'selected');
        });
        root.querySelectorAll<HTMLElement>(
            '.textLayer .highlight.selected, .text-layer .highlight.selected, .highlightOutline.selected',
        ).forEach((element) => {
            element.classList.remove('selected');
        });
        document.getSelection()?.removeAllRanges();
    }

    function resolveMarkerPageNumber(marker: HTMLElement) {
        const rawPage = marker.dataset.pageNumber ?? marker.getAttribute('data-page-number');
        const parsed = Number(rawPage ?? '');
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
        const pageContainer = marker.closest<HTMLElement>('.page_container[data-page]');
        if (!pageContainer) {
            return null;
        }
        const fromAttr = Number(pageContainer.getAttribute('data-page') ?? '');
        return Number.isFinite(fromAttr) && fromAttr > 0
            ? fromAttr
            : null;
    }

    function resolveCommentByMarkerGeometry(marker: HTMLElement) {
        const pageNumber = resolveMarkerPageNumber(marker);
        if (!pageNumber) {
            return null;
        }

        const pageContainer = marker.closest<HTMLElement>('.page_container[data-page]')
            ?? deps.viewerContainer.value?.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`)
            ?? null;
        if (!pageContainer) {
            return null;
        }
        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return null;
        }

        const markerRect = marker.getBoundingClientRect();
        const markerCenterX = markerRect.left + markerRect.width / 2;
        const markerCenterY = markerRect.top + markerRect.height / 2;
        const maxDistance = marker.classList.contains('pdf-inline-comment-anchor-marker')
            ? 36
            : 92;

        let best: {
            comment: IAnnotationCommentSummary;
            distance: number;
        } | null = null;
        const candidates = deps.getAnnotationComments().filter(comment => (
            comment.pageNumber === pageNumber
            && comment.hasNote
            && Boolean(normalizeMarkerRect(comment.markerRect))
        ));
        for (const candidate of candidates) {
            const normalized = normalizeMarkerRect(candidate.markerRect);
            if (!normalized) {
                continue;
            }
            const candidateX = pageRect.left + ((normalized.left + normalized.width) * pageRect.width);
            const candidateY = pageRect.top + (normalized.top * pageRect.height);
            const distance = Math.hypot(candidateX - markerCenterX, candidateY - markerCenterY);
            if (!Number.isFinite(distance) || distance > maxDistance) {
                continue;
            }
            if (!best || distance < best.distance) {
                best = {
                    comment: candidate,
                    distance,
                };
            }
        }
        return best?.comment ?? null;
    }

    function resolveCommentFromIndicatorElement(indicator: HTMLElement) {
        const directStableKey = indicator.dataset.commentStableKey ?? indicator.getAttribute('data-comment-stable-key');
        if (directStableKey) {
            const byStableKey = deps.identity.findCommentByStableKey(directStableKey);
            if (byStableKey) {
                return byStableKey;
            }
        }

        const stableKeys = deps.parseStableKeysAttr(indicator.getAttribute('data-comment-stable-keys'));
        const fromStableKeys = deps.pickBestCommentFromStableKeys(stableKeys);
        if (fromStableKeys) {
            return fromStableKeys;
        }

        const pageNumberRaw = indicator.dataset.pageNumber ?? null;
        const pageNumber = pageNumberRaw && Number.isFinite(Number(pageNumberRaw))
            ? Number(pageNumberRaw)
            : null;

        const byAnnotationId = deps.identity.findCommentByAnnotationId(
            indicator.dataset.annotationId ?? indicator.getAttribute('data-annotation-id'),
            pageNumber,
        );
        if (byAnnotationId) {
            return byAnnotationId;
        }
        return resolveCommentByMarkerGeometry(indicator);
    }

    function resolveCommentFromIndicatorClickTarget(target: HTMLElement) {
        const customIndicator = target.closest<HTMLElement>('.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker');
        if (customIndicator) {
            const inlineTarget = customIndicator.closest<HTMLElement>('.pdf-annotation-has-note-target, .pdf-annotation-has-comment');
            return (
                resolveCommentFromIndicatorElement(customIndicator)
                ?? (inlineTarget ? findCommentFromInlineTarget(inlineTarget) : null)
            );
        }

        const popupTrigger = target.closest<HTMLElement>('.annotationLayer .popupTriggerArea, .annotation-layer .popupTriggerArea');
        if (popupTrigger) {
            return null;
        }

        return null;
    }

    function findCommentFromInlineTarget(target: HTMLElement) {
        const stableKeys = deps.getInlineTargetStableKeys(target);
        if (stableKeys.length > 0) {
            return deps.pickBestCommentFromStableKeys(stableKeys);
        }
        const stableKey = target.getAttribute('data-comment-stable-key');
        if (!stableKey) {
            return null;
        }
        return deps.identity.findCommentByStableKey(stableKey);
    }

    function pulseCommentIndicator(stableKey: string) {
        const container = deps.viewerContainer.value;
        if (!container) {
            return;
        }
        stopInlineCommentFocusPulseTimeout();

        container.querySelectorAll<HTMLElement>('.pdf-comment-focus-pulse').forEach((element) => {
            element.classList.remove('pdf-comment-focus-pulse');
        });

        const escapedStableKey = escapeCssAttr(stableKey);
        const inlineTargets = Array.from(container.querySelectorAll<HTMLElement>(`[data-comment-stable-key="${escapedStableKey}"]`));
        const multiTargets = Array
            .from(container.querySelectorAll<HTMLElement>('[data-comment-stable-keys]'))
            .filter(target => deps.getInlineTargetStableKeys(target).includes(stableKey));
        const markers = Array
            .from(container.querySelectorAll<HTMLElement>('.pdf-inline-comment-marker, .pdf-inline-comment-anchor-marker'))
            .filter(marker => deps.markerIncludesStableKey(marker, stableKey));

        const pulseTargets = uniq([
            ...inlineTargets,
            ...multiTargets,
            ...markers,
        ]);
        if (pulseTargets.length === 0) {
            return;
        }

        pulseTargets.forEach((target) => {
            target.classList.add('pdf-comment-focus-pulse');
        });
        startInlineCommentFocusPulseTimeout();
    }

    function resolveCommentFromMarkerWithFallback(marker: HTMLElement) {
        const resolved = resolveCommentFromIndicatorElement(marker);
        if (resolved) {
            return resolved;
        }

        const directStableKey = marker.dataset.commentStableKey?.trim() ?? '';
        if (directStableKey) {
            const byStableKey = deps.identity.findCommentByStableKey(directStableKey);
            if (byStableKey) {
                return byStableKey;
            }
        }

        const stableKeys = deps.parseStableKeysAttr(marker.getAttribute('data-comment-stable-keys'));
        for (const stableKey of stableKeys) {
            const byStableKey = deps.identity.findCommentByStableKey(stableKey);
            if (byStableKey) {
                return byStableKey;
            }
        }

        const annotationId = marker.dataset.annotationId?.trim() ?? '';
        if (annotationId) {
            const pageNumberRaw = Number(marker.dataset.pageNumber ?? '');
            const pageNumber = Number.isFinite(pageNumberRaw) ? pageNumberRaw : null;
            const byAnnotationId = deps.identity.findCommentByAnnotationId(annotationId, pageNumber);
            if (byAnnotationId) {
                return byAnnotationId;
            }
        }

        return resolveCommentByMarkerGeometry(marker);
    }

    function upsertInlineCommentAnchorMarker(target: HTMLElement, stableKeys: string[], fallbackText: string) {
        if (stableKeys.length === 0) {
            target.querySelectorAll('.pdf-inline-comment-anchor-marker').forEach((marker) => {
                marker.remove();
            });
            return;
        }

        const best = deps.pickBestCommentFromStableKeys(stableKeys);
        const base = best
            ? commentPreviewText(best, t('annotations.emptyNote'))
            : (fallbackText.trim() || t('annotations.emptyNote'));
        const preview = stableKeys.length > 1
            ? `${base} (${t('annotations.moreNotes', { count: stableKeys.length - 1 })})`
            : base;
        const summary = deps.pickBestCommentFromStableKeys(stableKeys);
        const marker = (
            target.querySelector('.pdf-inline-comment-anchor-marker') as HTMLButtonElement | null
        ) ?? document.createElement('button');

        if (!marker.parentElement) {
            marker.type = 'button';
            marker.className = 'pdf-inline-comment-anchor-marker';
            marker.addEventListener('click', (event) => {
                const selected = resolveCommentFromMarkerWithFallback(marker);
                if (!selected) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                deps.setActiveCommentStableKey(selected.stableKey);
                pulseCommentIndicator(selected.stableKey);
                deps.emitAnnotationOpenNote(selected);
                clearTransientSelectionVisuals();
            });
            marker.addEventListener('contextmenu', (event) => {
                const selected = resolveCommentFromMarkerWithFallback(marker);
                if (!selected) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                deps.setActiveCommentStableKey(selected.stableKey);
                pulseCommentIndicator(selected.stableKey);
                deps.emitAnnotationContextMenu(deps.buildAnnotationContextMenuPayload(selected, event.clientX, event.clientY));
                clearTransientSelectionVisuals();
            });
            target.append(marker);
        }

        marker.dataset.commentStableKey = summary?.stableKey ?? stableKeys[0] ?? '';
        marker.dataset.commentStableKeys = deps.serializeStableKeysAttr(stableKeys);
        marker.dataset.annotationId = summary?.annotationId ?? '';
        marker.dataset.pageNumber = summary ? String(summary.pageNumber) : '';
        marker.dataset.commentCount = String(stableKeys.length);
        marker.dataset.commentPreview = preview;
        marker.classList.toggle('is-active', stableKeys.some(stableKey => deps.isCommentActive(stableKey)));
        marker.classList.toggle('is-cluster', stableKeys.length > 1);
        marker.setAttribute(
            'aria-label',
            stableKeys.length > 1
                ? t('annotations.openPopUpNoteCount', { count: stableKeys.length })
                : t('annotations.openPopUpNote'),
        );
        marker.setAttribute('title', preview);
        target.setAttribute('title', preview);
    }

    function createDetachedCommentClusterMarkerElement(
        comments: IAnnotationCommentSummary[],
        placement: {
            leftPercent: number;
            topPercent: number 
        },
        pickPrimaryFn: (comments: IAnnotationCommentSummary[]) => IAnnotationCommentSummary | undefined,
    ) {
        const primaryComment = pickPrimaryFn(comments);
        if (!primaryComment) {
            return null;
        }
        const noteCount = comments.length;
        const trimmedPreview = commentPreviewText(primaryComment, t('annotations.emptyNote'));
        const preview = noteCount > 1
            ? `${trimmedPreview} (${t('annotations.moreNotes', { count: noteCount - 1 })})`
            : trimmedPreview;

        const marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'pdf-inline-comment-marker';
        if (comments.some(candidate => deps.isCommentActive(candidate.stableKey))) {
            marker.classList.add('is-active');
        }
        if (noteCount > 1) {
            marker.classList.add('is-cluster');
            marker.dataset.commentCount = String(noteCount);
        }
        marker.dataset.commentStableKey = primaryComment.stableKey;
        marker.dataset.commentStableKeys = deps.serializeStableKeysAttr(comments.map(comment => comment.stableKey));
        marker.dataset.annotationId = primaryComment.annotationId ?? '';
        marker.dataset.pageNumber = String(primaryComment.pageNumber);
        marker.style.left = `${placement.leftPercent}%`;
        marker.style.top = `${placement.topPercent}%`;
        marker.title = preview;
        marker.setAttribute(
            'aria-label',
            noteCount > 1
                ? t('annotations.openPopUpNoteCount', { count: noteCount })
                : t('annotations.openPopUpNote'),
        );
        marker.addEventListener('click', (event) => {
            const resolved = resolveCommentFromMarkerWithFallback(marker);
            if (resolved) {
                event.preventDefault();
                event.stopPropagation();
                deps.setActiveCommentStableKey(resolved.stableKey);
                pulseCommentIndicator(resolved.stableKey);
                deps.emitAnnotationOpenNote(resolved);
                clearTransientSelectionVisuals();
            }
        });
        marker.addEventListener('contextmenu', (event) => {
            const resolved = resolveCommentFromMarkerWithFallback(marker);
            if (resolved) {
                event.preventDefault();
                event.stopPropagation();
                deps.setActiveCommentStableKey(resolved.stableKey);
                pulseCommentIndicator(resolved.stableKey);
                deps.emitAnnotationContextMenu(deps.buildAnnotationContextMenuPayload(resolved, event.clientX, event.clientY));
                clearTransientSelectionVisuals();
            }
        });
        return marker;
    }

    function clearPulseTimeout() {
        stopInlineCommentFocusPulseTimeout();
    }

    return {
        resolveCommentFromIndicatorElement,
        resolveCommentFromIndicatorClickTarget,
        findCommentFromInlineTarget,
        pulseCommentIndicator,
        upsertInlineCommentAnchorMarker,
        createDetachedCommentClusterMarkerElement,
        clearPulseTimeout,
    };
};
