import type {Ref} from 'vue';
import { useEventListener } from '@vueuse/core';
import type { TAnnotationTool } from '@app/types/annotations';

interface IPdfViewerForShortcuts {
    cancelCommentPlacement: () => void;
    deleteSelectedShape: () => void;
}

export interface IPageShortcutsDeps {
    isActive: Ref<boolean>;
    pdfSrc: Ref<unknown>;
    showSettings: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    annotationPlacingPageNote: Ref<boolean>;
    pdfViewerRef: Ref<IPdfViewerForShortcuts | null>;
    shapePropertiesPopoverVisible: Ref<boolean>;
    annotationContextMenuVisible: Ref<boolean>;
    pageContextMenuVisible: Ref<boolean>;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeShapeProperties: () => void;
    openSearch: () => void;
    openAnnotations: () => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
}

export const usePageShortcuts = (deps: IPageShortcutsDeps) => {
    const {
        isActive,
        pdfSrc,
        annotationTool,
        annotationPlacingPageNote,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
    } = deps;
    const shortcutListenerCleanups: Array<() => void> = [];
    let isSetup = false;

    function getWindowTarget() {
        if (typeof window === 'undefined') {
            return null;
        }
        return window;
    }

    function getEventTargetElement(target: EventTarget | null) {
        if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
            return null;
        }
        return target;
    }

    function handleGlobalShortcut(event: KeyboardEvent) {
        if (!isActive.value) {
            return;
        }

        const target = getEventTargetElement(event.target);
        const isEditingText = (
            target?.isContentEditable
            || target?.closest('[contenteditable="true"], [contenteditable=""]')
            || target?.closest('input, textarea, select')
        );
        if (isEditingText) {
            return;
        }

        if (event.key === 'Escape') {
            if (shapePropertiesPopoverVisible.value) {
                closeShapeProperties();
            }
            if (annotationContextMenuVisible.value) {
                closeAnnotationContextMenu();
            }
            if (pageContextMenuVisible.value) {
                closePageContextMenu();
            }
            if (annotationPlacingPageNote.value || annotationTool.value !== 'none') {
                deps.handleAnnotationToolChange('none');
            }
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && pdfSrc.value) {
            event.preventDefault();
            openSearch();
        }
    }

    function handleGlobalPointerDown(event: PointerEvent) {
        if (!isActive.value) {
            return;
        }
        const target = getEventTargetElement(event.target);

        if (shapePropertiesPopoverVisible.value) {
            if (!target?.closest('.annotation-properties')) {
                closeShapeProperties();
            }
        }

        if (annotationContextMenuVisible.value) {
            if (!target?.closest('.annotation-context-menu')) {
                closeAnnotationContextMenu();
            }
        }

        if (pageContextMenuVisible.value) {
            if (!target?.closest('.page-context-menu')) {
                closePageContextMenu();
            }
        }
    }

    function setupShortcuts() {
        if (isSetup) {
            return;
        }

        const target = getWindowTarget();
        if (!target) {
            return;
        }

        isSetup = true;
        shortcutListenerCleanups.push(useEventListener(target, 'keydown', handleGlobalShortcut));
        shortcutListenerCleanups.push(useEventListener(target, 'pointerdown', handleGlobalPointerDown));
    }

    function cleanupShortcuts() {
        if (!isSetup && shortcutListenerCleanups.length === 0) {
            return;
        }

        isSetup = false;
        while (shortcutListenerCleanups.length > 0) {
            const cleanup = shortcutListenerCleanups.pop();
            cleanup?.();
        }
    }

    return {
        setupShortcuts,
        cleanupShortcuts,
    };
};
