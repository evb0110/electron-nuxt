import type { Ref } from 'vue';
import {
    useEventListener,
    useMagicKeys,
    whenever,
} from '@vueuse/core';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdf';
import { shouldHandleRendererMenuAccelerators } from '@app/utils/platformShortcuts';

interface IPdfViewerForShortcuts {
    cancelCommentPlacement: () => void;
    deleteSelectedShape: () => void;
}

interface IPageShortcutsDeps {
    isActive: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    canSave: Ref<boolean>;
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
    handlePrint: () => void;
    handleToggleSidebar: () => void;
}

function isEditingText(target: EventTarget | null) {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) {
        return false;
    }
    return Boolean(
        target.isContentEditable
        || target.closest('[contenteditable="true"], [contenteditable=""]')
        || target.closest('input, textarea, select'),
    );
}

function isZoomInKey(event: KeyboardEvent) {
    return event.key === '=' || event.key === '+' || event.code === 'NumpadAdd';
}

function isZoomOutKey(event: KeyboardEvent) {
    return event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract';
}

function isActualSizeKey(event: KeyboardEvent) {
    return event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0';
}

function eventHasCommandModifier(event: KeyboardEvent) {
    return event.ctrlKey || event.metaKey;
}

function targetAsElement(target: EventTarget | null) {
    return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement
        ? target
        : null;
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

    function handleEscape() {
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
    }

    function handleDeleteShortcut(event: KeyboardEvent) {
        if ((event.key !== 'Delete' && event.key !== 'Backspace') || !pdfSrc.value) {
            return false;
        }
        event.preventDefault();
        deps.pdfViewerRef.value?.deleteSelectedShape();
        return true;
    }

    function handlePrintShortcut(event: KeyboardEvent, key: string, shouldHandleRendererAccelerators: boolean) {
        if (key !== 'p' || event.shiftKey || !shouldHandleRendererAccelerators) {
            return false;
        }
        event.preventDefault();
        deps.handlePrint();
        return true;
    }

    function handleSaveShortcut(event: KeyboardEvent, key: string, shouldHandleRendererAccelerators: boolean) {
        if (key !== 's' || event.shiftKey || !shouldHandleRendererAccelerators) {
            return false;
        }
        event.preventDefault();
        if (!deps.canSave.value) {
            return true;
        }
        deps.handleSave();
        return true;
    }

    function handleSearchShortcut(event: KeyboardEvent, key: string) {
        if (key !== 'f' || event.shiftKey) {
            return false;
        }
        event.preventDefault();
        openSearch();
        return true;
    }

    function preventReactiveLetterShortcut(event: KeyboardEvent, key: string, shouldHandleRendererAccelerators: boolean) {
        if (key === 'b' || key === 'f') {
            event.preventDefault();
        }
        if (key === 's' && !event.shiftKey && shouldHandleRendererAccelerators) {
            event.preventDefault();
        }
    }

    function handleZoomShortcut(event: KeyboardEvent, shouldHandleRendererAccelerators: boolean) {
        if (!shouldHandleRendererAccelerators) {
            return false;
        }
        if (isZoomInKey(event)) {
            event.preventDefault();
            deps.handleZoomIn();
            return true;
        }
        if (isZoomOutKey(event)) {
            event.preventDefault();
            deps.handleZoomOut();
            return true;
        }
        if (isActualSizeKey(event)) {
            event.preventDefault();
            deps.handleActualSize();
            return true;
        }
        return false;
    }

    function suppressBrowserDefaultForConflictingAccelerator(event: KeyboardEvent) {
        // Web-only: stop Chromium's built-in handlers (Save Page As, Print,
        // Open File) from hijacking these accelerators. On Electron the
        // OS menu accelerator delivers these shortcuts via menu:save / menu:print
        // IPC and we MUST NOT preventDefault here — doing so suppresses
        // the menu accelerator and makes Cmd+S a no-op in the desktop app.
        if (!shouldHandleRendererMenuAccelerators()) {
            return;
        }
        if (!eventHasCommandModifier(event) || event.altKey) {
            return;
        }
        const key = event.key.toLowerCase();
        if (key === 's' || key === 'p' || key === 'o') {
            event.preventDefault();
        }
    }

    function handleCapturedWebMenuAccelerator(event: KeyboardEvent) {
        if (!shouldHandleRendererMenuAccelerators()) {
            return;
        }
        if (!eventHasCommandModifier(event) || event.altKey) {
            return;
        }

        const key = event.key.toLowerCase();
        if (key !== 's' && key !== 'p' && key !== 'o') {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        if (!isActive.value || !pdfSrc.value || event.shiftKey) {
            return;
        }

        if (key === 's') {
            if (!deps.canSave.value) {
                return;
            }
            deps.handleSave();
            return;
        }
        if (key === 'p') {
            deps.handlePrint();
        }
    }

    function handleKeyboardShortcut(event: KeyboardEvent) {
        if (event.defaultPrevented) {
            return;
        }
        suppressBrowserDefaultForConflictingAccelerator(event);

        if (!isActive.value) {
            return;
        }

        const hasMod = eventHasCommandModifier(event);
        if (hasMod && event.altKey) {
            return;
        }

        if (event.key === 'Escape') {
            handleEscape();
            return;
        }

        if (!hasMod || !pdfSrc.value) {
            editableBlocked.value = isEditingText(event.target);
            if (editableBlocked.value) {
                return;
            }
            if (handleDeleteShortcut(event)) {
                return;
            }
            return;
        }

        const key = event.key.toLowerCase();
        const shouldHandleRendererAccelerators = shouldHandleRendererMenuAccelerators();

        if (handleSaveShortcut(event, key, shouldHandleRendererAccelerators)) {
            return;
        }
        if (handlePrintShortcut(event, key, shouldHandleRendererAccelerators)) {
            return;
        }
        if (handleSearchShortcut(event, key)) {
            return;
        }

        editableBlocked.value = isEditingText(event.target);
        if (editableBlocked.value) {
            return;
        }

        preventReactiveLetterShortcut(event, key, shouldHandleRendererAccelerators);
        handleZoomShortcut(event, shouldHandleRendererAccelerators);
    }

    // Tracks whether the most recent keydown targeted an editable element,
    // so the reactive `whenever` watchers can skip those events.
    const editableBlocked = ref(false);

    const keys = useMagicKeys({
        passive: false,
        onEventFired(e) {
            if (e.type !== 'keydown') {
                return;
            }
            handleKeyboardShortcut(e);
        },
    });

    // Reactive guards shared by letter shortcuts
    // Optional chaining required because noUncheckedIndexedAccess is enabled
    // and useMagicKeys exposes keys via an index signature.
    const canFire = computed(() => isActive.value && !editableBlocked.value);
    const hasMod = computed(() => (keys.ctrl?.value ?? false) || (keys.meta?.value ?? false));
    const modReady = computed(() => canFire.value && hasMod.value && !(keys.alt?.value ?? false) && !!pdfSrc.value);

    // Letter shortcuts — reactive via whenever
    whenever(() => modReady.value && (keys.b?.value ?? false), () => deps.handleToggleSidebar());
    // Pointerdown — close menus on outside clicks
    function handleGlobalPointerDown(event: PointerEvent) {
        if (!isActive.value) {
            return;
        }

        const target = targetAsElement(event.target);

        if (shapePropertiesPopoverVisible.value && !target?.closest('.annotation-properties')) {
            closeShapeProperties();
        }
        if (annotationContextMenuVisible.value && !target?.closest('.annotation-context-menu')) {
            closeAnnotationContextMenu();
        }
        if (pageContextMenuVisible.value && !target?.closest('.page-context-menu')) {
            closePageContextMenu();
        }
    }

    const windowTarget = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
        ? window
        : null;
    useEventListener(windowTarget, 'pointerdown', handleGlobalPointerDown);
    useEventListener(windowTarget, 'keydown', handleCapturedWebMenuAccelerator, { capture: true });
};
