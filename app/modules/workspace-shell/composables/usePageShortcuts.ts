import type { Ref } from 'vue';
import {
    useMagicKeys,
    useEventListener,
    whenever,
} from '@vueuse/core';
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
    handleToggleSidebar: () => void;
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

    // Tracks whether the most recent keydown targeted an editable element,
    // so the reactive `whenever` watchers can skip those events.
    const editableBlocked = ref(false);

    const keys = useMagicKeys({
        passive: false,
        onEventFired(e) {
            if (e.type !== 'keydown') {
                return;
            }

            editableBlocked.value = isEditingText(e.target);
            if (!isActive.value || editableBlocked.value) {
                return;
            }

            const hasMod = e.ctrlKey || e.metaKey;
            if (hasMod && e.altKey) {
                return;
            }

            // Escape — fully imperative (no modifier key)
            if (e.key === 'Escape') {
                handleEscape();
                return;
            }

            if ((e.key === 'Delete' || e.key === 'Backspace') && pdfSrc.value) {
                e.preventDefault();
                deps.pdfViewerRef.value?.deleteSelectedShape();
                return;
            }

            if (!hasMod || !pdfSrc.value) {
                return;
            }

            const key = e.key.toLowerCase();

            // preventDefault for reactive letter shortcuts
            if (key === 'b' || key === 'f') {
                e.preventDefault();
            }
            if (key === 's' && !e.shiftKey && !hasElectronAPI()) {
                e.preventDefault();
            }

            // Zoom — fully imperative (special key chars not compatible with reactive combos)
            if (!hasElectronAPI()) {
                if (isZoomInKey(e)) {
                    e.preventDefault();
                    deps.handleZoomIn();
                    return;
                }
                if (isZoomOutKey(e)) {
                    e.preventDefault();
                    deps.handleZoomOut();
                    return;
                }
                if (isActualSizeKey(e)) {
                    e.preventDefault();
                    deps.handleActualSize();
                }
            }
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
    whenever(() => modReady.value && (keys.f?.value ?? false), () => openSearch());
    whenever(
        () => modReady.value && (keys.s?.value ?? false) && !(keys.shift?.value ?? false) && !hasElectronAPI(),
        () => deps.handleSave(),
    );

    // Pointerdown — close menus on outside clicks
    function handleGlobalPointerDown(event: PointerEvent) {
        if (!isActive.value) {
            return;
        }

        const target = (typeof HTMLElement !== 'undefined' && event.target instanceof HTMLElement)
            ? event.target
            : null;

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

    if (typeof window !== 'undefined') {
        useEventListener(window, 'pointerdown', handleGlobalPointerDown);
    }
};
