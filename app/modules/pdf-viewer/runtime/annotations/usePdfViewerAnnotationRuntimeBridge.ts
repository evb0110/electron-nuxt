import type {
    ComputedRef,
    Ref,
    ShallowRef,
} from 'vue';
import {
    tryOnScopeDispose,
    useEventListener,
    useMutationObserver,
} from '@vueuse/core';
import { PixelsPerInch } from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { useAnnotationOrchestrator } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationOrchestrator';
import { runGuardedTask } from '@app/utils/asyncGuard';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { applyAnnotationCommentTextMarkupColor } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor';
import { syncAnnotationCommentTextMarkupVisualOverlays } from '@app/utils/pdf-viewer/annotations/annotation-dom-removal/syncAnnotationCommentTextMarkupVisualOverlays';
import { toOpaqueHighlightDisplayColor } from '@app/utils/pdf-viewer/text-markup-color/toOpaqueHighlightDisplayColor';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { BrowserLogger } from '@app/utils/browserLogger';

type TAnnotationOrchestrator = ReturnType<typeof useAnnotationOrchestrator>;

interface IUsePdfViewerAnnotationRuntimeBridgeOptions {
    viewerContainer: Ref<HTMLElement | null>;
    isActive: ComputedRef<boolean>;
    currentPage: Ref<number>;
    effectiveScale: Ref<number>;
    annotationTool: ComputedRef<TAnnotationTool>;
    annotationCursorMode: ComputedRef<boolean>;
    annotationSettings: ComputedRef<IAnnotationSettings | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    activeCommentStableKey: Ref<string | null>;
    annotations: TAnnotationOrchestrator;
}

export function usePdfViewerAnnotationRuntimeBridge(options: IUsePdfViewerAnnotationRuntimeBridgeOptions) {
    const {
        viewerContainer,
        isActive,
        currentPage,
        effectiveScale,
        annotationTool,
        annotationCursorMode,
        annotationSettings,
        annotationUiManager,
        annotationCommentsCache,
        activeCommentStableKey,
        annotations,
    } = options;
    const {
        editor,
        highlight,
    } = annotations;
    const pendingTextMarkupColorSyncTimers = new Set<ReturnType<typeof setTimeout>>();
    let pendingTextMarkupColorSyncFrame: number | null = null;

    function scheduleSetAnnotationTool(tool: TAnnotationTool, stage: string) {
        runGuardedTask(() => editor.setAnnotationTool(tool), {
            scope: 'pdf-viewer',
            message: `Failed to ${stage}`,
        });
    }

    function resolveRenderedTextMarkupColor(comment: IAnnotationCommentSummary) {
        if (!comment.color) {
            return null;
        }
        if ((comment.subtype ?? '').trim().toLowerCase() !== 'highlight') {
            return comment.color;
        }
        return toOpaqueHighlightDisplayColor(
            comment.color,
            annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity,
        );
    }

    function resolveRenderedTextMarkupOverlayColor(comment: IAnnotationCommentSummary) {
        return comment.color?.trim() || null;
    }

    function resolveRenderedTextMarkupHighlightOpacity(comment: IAnnotationCommentSummary) {
        if ((comment.subtype ?? '').trim().toLowerCase() !== 'highlight') {
            return null;
        }
        return annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity;
    }

    function applyEditedTextMarkupColors(stage: string) {
        const container = viewerContainer.value;
        if (!container || !isActive.value) {
            return;
        }

        let attempted = 0;
        let applied = 0;
        for (const comment of annotationCommentsCache.value) {
            if (!comment.colorEdited || !isTextMarkupSubtype(comment.subtype)) {
                continue;
            }
            const color = resolveRenderedTextMarkupColor(comment);
            if (!color) {
                continue;
            }
            attempted += 1;
            if (applyAnnotationCommentTextMarkupColor(container, comment, color, { suppressNativeTextMarkupDecoration: true })) {
                applied += 1;
            }
        }
        applied += syncAnnotationCommentTextMarkupVisualOverlays(container, annotationCommentsCache.value, {
            resolveColor: resolveRenderedTextMarkupOverlayColor,
            resolveHighlightOpacity: resolveRenderedTextMarkupHighlightOpacity,
        });

        if (attempted > 0) {
            BrowserLogger.debug('annotations', 'Reapplied edited text markup colors', {
                applied,
                attempted,
                stage,
            });
        }
    }

    function cancelPendingTextMarkupColorSync() {
        if (pendingTextMarkupColorSyncFrame !== null && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(pendingTextMarkupColorSyncFrame);
        }
        pendingTextMarkupColorSyncFrame = null;
        pendingTextMarkupColorSyncTimers.forEach(timer => clearTimeout(timer));
        pendingTextMarkupColorSyncTimers.clear();
    }

    function scheduleEditedTextMarkupColorSync(stage: string) {
        if (!isActive.value) {
            return;
        }
        if (pendingTextMarkupColorSyncFrame !== null || pendingTextMarkupColorSyncTimers.size > 0) {
            return;
        }
        if (pendingTextMarkupColorSyncFrame === null && typeof requestAnimationFrame === 'function') {
            pendingTextMarkupColorSyncFrame = requestAnimationFrame(() => {
                pendingTextMarkupColorSyncFrame = null;
                applyEditedTextMarkupColors(`${stage}:frame`);
            });
        } else if (pendingTextMarkupColorSyncFrame === null) {
            queueMicrotask(() => applyEditedTextMarkupColors(`${stage}:microtask`));
        }

        [
            80,
            180,
            360,
        ].forEach((delayMs) => {
            const timer = setTimeout(() => {
                pendingTextMarkupColorSyncTimers.delete(timer);
                applyEditedTextMarkupColors(`${stage}:delay-${delayMs}`);
            }, delayMs);
            pendingTextMarkupColorSyncTimers.add(timer);
        });
    }

    function isEditedTextMarkupOverlayMutationNode(node: Node) {
        if (!(node instanceof Element)) {
            return false;
        }
        return node.matches('svg[data-evb-edited-text-markup-overlay="true"]')
            || Boolean(node.closest('svg[data-evb-edited-text-markup-overlay="true"]'));
    }

    const documentTarget = typeof document !== 'undefined' ? document : null;
    useEventListener(
        documentTarget,
        'selectionchange',
        () => {
            if (isActive.value) {
                highlight.cacheCurrentTextSelection();
            }
        },
        { passive: true },
    );
    useEventListener(
        documentTarget,
        'pointerup',
        (event) => {
            if (isActive.value && event instanceof PointerEvent) {
                highlight.handleDocumentPointerUp(event);
            }
        },
        { passive: true },
    );

    const annotationCommentStableKeys = computed(() =>
        annotationCommentsCache.value.map(comment => comment.stableKey),
    );
    watch(
        annotationCommentStableKeys,
        (stableKeys) => {
            const activeKey = activeCommentStableKey.value;
            if (!activeKey) {
                return;
            }
            if (!stableKeys.includes(activeKey)) {
                activeCommentStableKey.value = null;
            }
        },
    );

    watch(effectiveScale, (scale) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onScaleChanging({ scale: scale / PixelsPerInch.PDF_TO_CSS_UNITS });
        const syncMarkupSubtypePresentation = () => {
            annotations.editor.markupSubtype.syncMarkupSubtypePresentationForEditors();
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(syncMarkupSubtypePresentation);
        } else {
            queueMicrotask(syncMarkupSubtypePresentation);
        }
        scheduleEditedTextMarkupColorSync('scale');
    });

    watch(
        () => annotationCommentsCache.value.map(comment => [
            comment.stableKey,
            comment.annotationId ?? '',
            comment.pageNumber,
            comment.subtype ?? '',
            comment.color ?? '',
            comment.colorEdited ? '1' : '0',
            comment.markerRect?.left ?? '',
            comment.markerRect?.top ?? '',
            comment.markerRect?.width ?? '',
            comment.markerRect?.height ?? '',
        ].join(':')),
        () => {
            scheduleEditedTextMarkupColorSync('comments');
        },
    );

    useMutationObserver(
        viewerContainer,
        (mutations) => {
            const shouldSync = mutations.some(mutation => (
                mutation.type === 'childList'
                && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
                && !isEditedTextMarkupOverlayMutationNode(mutation.target)
                && [
                    ...Array.from(mutation.addedNodes),
                    ...Array.from(mutation.removedNodes),
                ].some(node => !isEditedTextMarkupOverlayMutationNode(node))
            ));
            if (shouldSync) {
                scheduleEditedTextMarkupColorSync('dom');
            }
        },
        {
            childList: true,
            subtree: true,
        },
    );

    watch(currentPage, (page) => {
        if (!isActive.value) {
            return;
        }
        annotationUiManager.value?.onPageChanging({ pageNumber: page });
    });

    watch(
        annotationTool,
        (tool) => {
            if (!isActive.value) {
                return;
            }
            if (tool !== 'none') {
                highlight.cancelCommentPlacement();
            }
            scheduleSetAnnotationTool(tool, `apply annotation tool "${tool}"`);
        },
        { immediate: true },
    );

    watch(annotationCursorMode, () => {
        if (!isActive.value) {
            return;
        }
        if (annotationTool.value === 'none') {
            scheduleSetAnnotationTool('none', 're-apply annotation cursor mode');
        }
    });

    const annotationSettingsSignature = computed(() => {
        const settings = annotationSettings.value;
        if (!settings) {
            return '';
        }
        return Object.values(settings).join('|');
    });
    watch(
        annotationSettingsSignature,
        () => {
            if (!isActive.value) {
                return;
            }
            editor.applyAnnotationSettings(annotationSettings.value);
            scheduleEditedTextMarkupColorSync('settings');
        },
        { immediate: true },
    );

    tryOnScopeDispose(() => {
        cancelPendingTextMarkupColorSync();
    });

    return {scheduleSetAnnotationTool};
}
