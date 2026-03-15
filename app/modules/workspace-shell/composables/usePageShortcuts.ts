import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { hasElectronAPI } from '@app/utils/platform';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdf';

interface IPdfViewerForShortcuts {
    cancelCommentPlacement: () => void;
    deleteSelectedShape: () => void;
}

interface IPageShortcutsDeps {
    isActive: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
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
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    handleActualSize: () => void;
    handleSave: () => void;
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

    function isZoomInShortcut(event: KeyboardEvent) {
        return event.key === '=' || event.key === '+' || event.code === 'NumpadAdd';
    }

    function isZoomOutShortcut(event: KeyboardEvent) {
        return event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract';
    }

    function isActualSizeShortcut(event: KeyboardEvent) {
        return event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0';
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

        const hasZoomModifier = event.metaKey || event.ctrlKey;
        if (hasZoomModifier && event.altKey) {
            return;
        }

        if (hasZoomModifier && pdfSrc.value && !hasElectronAPI()) {
            if (event.key.toLowerCase() === 's' && !event.shiftKey) {
                event.preventDefault();
                deps.handleSave();
                return;
            }

            if (isZoomInShortcut(event)) {
                event.preventDefault();
                deps.handleZoomIn();
                return;
            }

            if (isZoomOutShortcut(event)) {
                event.preventDefault();
                deps.handleZoomOut();
                return;
            }

            if (isActualSizeShortcut(event)) {
                event.preventDefault();
                deps.handleActualSize();
                return;
            }
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

        if (hasZoomModifier && event.key.toLowerCase() === 'f' && pdfSrc.value) {
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
