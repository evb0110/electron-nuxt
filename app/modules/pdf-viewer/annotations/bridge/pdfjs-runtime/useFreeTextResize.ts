// PDF.js-private FreeText executor; exposed through the runtime port.
import { AnnotationEditorParamsType } from '@app/services/pdfjs/runtimeLib';
import {
    tryOnScopeDispose,
    useEventListener,
} from '@vueuse/core';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { clamp } from 'es-toolkit/math';
import type { TAnnotationSettingChange } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { detectEditorSubtype } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/detectEditorSubtype';
import {
    getEditorParentDimensions,
    getPdfjsEditorFacadeState,
    getEditorsOnPage,
    getEditorSerializedData,
    isEditorDraggable,
    isEditorInEditMode,
    makeEditorResizable,
    markEditorResizable,
    patchEditorResizeHandlers,
    patchEditorUpdateParams,
    refreshEditorLayout,
    syncEditorToAnnotationStorage,
    setSelectedEditor,
    setEditorDraggable,
    updateEditorParams,
    updatePdfjsAnnotationManagerParams,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import { BrowserLogger } from '@app/utils/browserLogger';

const FREE_TEXT_FONT_SIZE_MIN = 8;
const FREE_TEXT_FONT_SIZE_MAX = 96;

interface IUseFreeTextResizeOptions {
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
    getNumPages: () => number;
    emitAnnotationModified: () => void;
    emitAnnotationSetting: (payload: TAnnotationSettingChange) => void;
    scheduleAnnotationCommentsSync: () => void;
    registerHistoryCommand?: (command: {
        cmd: () => void;
        undo: () => void
    }) => void;
}

interface IFreeTextResizeSnapshot {
    x: number | undefined;
    y: number | undefined;
    width: number | undefined;
    height: number | undefined;
    fontSize: number;
}

export const useFreeTextResize = (options: IUseFreeTextResizeOptions) => {
    const {
        getAnnotationUiManager,
        getNumPages,
        emitAnnotationModified,
        emitAnnotationSetting,
        scheduleAnnotationCommentsSync,
        registerHistoryCommand,
    } = options;
    const resizeCursorCleanupTarget = ref<Window | null>(null);
    const pendingFreeTextResizeSyncFrames = new Set<number>();
    let activeResizeCursorClass: string | null = null;
    let disposed = false;
    const resizeStartSnapshots = new WeakMap<IPdfjsEditor, IFreeTextResizeSnapshot>();

    function editorHistoryKey(editor: IPdfjsEditor) {
        return editor.annotationElementId ?? editor.id ?? null;
    }

    function resolveCurrentEditor(key: string | null) {
        if (!key) {
            return null;
        }
        const manager = getAnnotationUiManager();
        if (!manager) {
            return null;
        }
        for (let pageIndex = 0; pageIndex < getNumPages(); pageIndex += 1) {
            const editor = getEditorsOnPage(manager, pageIndex).find(candidate => (
                candidate.annotationElementId === key || candidate.id === key
            ));
            if (editor) {
                return editor;
            }
        }
        return null;
    }

    function captureResizeSnapshot(editor: IPdfjsEditor, fontSize: number): IFreeTextResizeSnapshot {
        return {
            x: editor.x,
            y: editor.y,
            width: editor.width,
            height: editor.height,
            fontSize,
        };
    }

    function applyResizeSnapshot(editor: IPdfjsEditor, snapshot: IFreeTextResizeSnapshot) {
        if (snapshot.x !== undefined) editor.x = snapshot.x;
        if (snapshot.y !== undefined) editor.y = snapshot.y;
        if (snapshot.width !== undefined) editor.width = snapshot.width;
        if (snapshot.height !== undefined) editor.height = snapshot.height;
        applyFreeTextInternalFontSize(editor, snapshot.fontSize);
        updateFreeTextResizerSize(editor);
        refreshEditorLayout(editor);
        syncEditorToAnnotationStorage(editor);
        emitAnnotationModified();
        scheduleAnnotationCommentsSync();
    }

    function cleanupResizeCursor() {
        if (activeResizeCursorClass && typeof document !== 'undefined') {
            document.documentElement.classList.remove(activeResizeCursorClass);
            activeResizeCursorClass = null;
        }
        resizeCursorCleanupTarget.value = null;
    }

    function cancelPendingFreeTextFontSyncs() {
        pendingFreeTextResizeSyncFrames.forEach(frame => cancelAnimationFrame(frame));
        pendingFreeTextResizeSyncFrames.clear();
    }

    useEventListener(resizeCursorCleanupTarget, 'pointerup', cleanupResizeCursor);
    useEventListener(resizeCursorCleanupTarget, 'blur', cleanupResizeCursor);

    function parseEditorInlineFontSizePx(value: string) {
        const calcMatch = value.match(/calc\(([\d.]+)px\s*\*/);
        if (calcMatch?.[1]) {
            const parsed = Number.parseFloat(calcMatch[1]);
            if (Number.isFinite(parsed) && parsed > 0) {
                return parsed;
            }
        }
        const pxMatch = value.match(/([\d.]+)px/);
        if (!pxMatch?.[1]) {
            return null;
        }
        const parsed = Number.parseFloat(pxMatch[1]);
        return Number.isFinite(parsed) && parsed > 0
            ? parsed
            : null;
    }

    function readSerializedFontSize(editor: IPdfjsEditor) {
        const serialized = getEditorSerializedData(editor);
        if (
            serialized
            && typeof serialized === 'object'
            && 'fontSize' in serialized
            && typeof (serialized as { fontSize?: unknown }).fontSize === 'number'
        ) {
            const fontSize = (serialized as { fontSize: number }).fontSize;
            if (Number.isFinite(fontSize) && fontSize > 0) {
                return fontSize;
            }
        }
        return null;
    }

    function readInternalFontSize(internal: HTMLElement) {
        const inlineFontSize = parseEditorInlineFontSizePx(internal.style.fontSize);
        if (inlineFontSize) {
            return inlineFontSize;
        }

        const computedStyle = getComputedStyle(internal);
        const computedFontSize = Number.parseFloat(computedStyle.fontSize);
        if (!Number.isFinite(computedFontSize) || computedFontSize <= 0) {
            return null;
        }

        const scaleToken = computedStyle.getPropertyValue('--total-scale-factor').trim();
        const scale = Number.parseFloat(scaleToken);
        return Number.isFinite(scale) && scale > 0
            ? computedFontSize / scale
            : computedFontSize;
    }

    function getFreeTextEditorFontSize(editor: IPdfjsEditor) {
        const serializedFontSize = readSerializedFontSize(editor);
        if (serializedFontSize) {
            return serializedFontSize;
        }

        const internal = editor.div?.querySelector<HTMLElement>('.internal');
        if (!internal) {
            return null;
        }

        return readInternalFontSize(internal);
    }

    function updateFreeTextResizerSize(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const rect = div.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return;
        }

        const maxCornerSize = Math.floor((Math.min(rect.width, rect.height) - 2) / 2);
        const nextSize = clamp(maxCornerSize, 4, 10);
        div.style.setProperty('--evb-resizer-size', `${nextSize}px`);
    }

    function addResizeCursorManagement(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const resizers = div.querySelectorAll<HTMLElement>('.resizer');
        for (const resizer of resizers) {
            if (resizer.dataset.evbResizeCursorBound === '1') {
                continue;
            }
            resizer.dataset.evbResizeCursorBound = '1';
            resizer.addEventListener('pointerdown', () => {
                const isNWSE = resizer.classList.contains('topLeft')
                    || resizer.classList.contains('bottomRight');
                const cursorClass = isNWSE ? 'pdf-resizing-nwse' : 'pdf-resizing-nesw';
                cleanupResizeCursor();
                document.documentElement.classList.add(cursorClass);
                activeResizeCursorClass = cursorClass;
                resizeCursorCleanupTarget.value = window;
            });
        }
    }

    function patchFreeTextPreSelect(editor: IPdfjsEditor) {
        const editorState = getPdfjsEditorFacadeState(editor);
        if (editorState.freeTextPreSelectPatched) {
            return;
        }

        const div = editor.div;
        if (!div) {
            return;
        }

        div.addEventListener('pointerdown', handleFreeTextPreSelectPointerDown(editor), { capture: true });
        editorState.freeTextPreSelectPatched = true;
    }

    function canPreSelectFreeTextEditor(editor: IPdfjsEditor, event: PointerEvent) {
        if (event.button !== 0) {
            return false;
        }
        if (isEditorInEditMode(editor)) {
            return false;
        }
        return Boolean(isEditorDraggable(editor) && !editor.isSelected);
    }

    function handleFreeTextPreSelectPointerDown(editor: IPdfjsEditor) {
        return (event: PointerEvent) => {
            if (!canPreSelectFreeTextEditor(editor, event)) {
                return;
            }
            const uiManager = getAnnotationUiManager();
            if (uiManager) {
                setSelectedEditor(uiManager, editor);
            }
        };
    }

    function isActualNaN(value: unknown) {
        return typeof value === 'number' && Number.isNaN(value);
    }

    function recoverNaNPosition(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const xBad = isActualNaN(editor.x);
        const yBad = isActualNaN(editor.y);
        if (!xBad && !yBad) {
            return;
        }
        const left = parseFloat(div.style.left);
        const top = parseFloat(div.style.top);
        if (xBad && Number.isFinite(left)) {
            editor.x = left / 100;
        }
        if (yBad && Number.isFinite(top)) {
            editor.y = top / 100;
        }
    }

    function recoverDimensionValue(isBad: boolean, measured: number, parent: number) {
        if (!isBad) {
            return null;
        }
        if (measured <= 0 || parent <= 0) {
            return null;
        }
        return measured / parent;
    }

    function assignRecoveredDimension(value: number | null, assign: (value: number) => void) {
        if (value !== null) {
            assign(value);
        }
    }

    function getRecoverableParentDimensions(editor: IPdfjsEditor) {
        return getEditorParentDimensions(editor);
    }

    function recoverNaNDimensions(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }
        const wBad = isActualNaN(editor.width);
        const hBad = isActualNaN(editor.height);
        if (!wBad && !hBad) {
            return;
        }
        const parentDims = getRecoverableParentDimensions(editor);
        if (!parentDims) {
            return;
        }
        const rect = div.getBoundingClientRect();
        const width = recoverDimensionValue(wBad, rect.width, parentDims.parentW);
        const height = recoverDimensionValue(hBad, rect.height, parentDims.parentH);
        assignRecoveredDimension(width, (value) => {
            editor.width = value;
        });
        assignRecoveredDimension(height, (value) => {
            editor.height = value;
        });
    }

    function ensureFreeTextEditorInteractivity(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            return;
        }

        const isEditing = isEditorInEditMode(editor);

        recoverNaNPosition(editor);
        recoverNaNDimensions(editor);

        if (!isEditing) {
            makeEditorResizable(editor);
            setEditorDraggable(editor, true);
            const overlay = div.querySelector<HTMLElement>('.overlay');
            if (overlay) {
                overlay.classList.add('enabled');
            }
        }

        patchFreeTextPreSelect(editor);
        updateFreeTextResizerSize(editor);
        addResizeCursorManagement(editor);
    }

    function patchFreeTextResizeFontSync(editor: IPdfjsEditor) {
        const editorState = getPdfjsEditorFacadeState(editor);
        if (editorState.freeTextResizeHookPatched) {
            return;
        }

        function captureRatio() {
            refreshFreeTextFontRatio(editor);
        }
        captureRatio();

        patchEditorUpdateParams(
            editor,
            (originalUpdateParams, type, value) => {
                const isExternalFontChange
                    = type === AnnotationEditorParamsType.FREETEXT_SIZE
                    && !editorState.freeTextIsResizeSync;
                if (isExternalFontChange && shouldResetFreeTextDimensionsForFontChange(editor, value)) {
                    resetFreeTextDimensions(editor);
                }
                originalUpdateParams(type, value);
                if (isExternalFontChange) {
                    refreshFreeTextFontRatio(editor);
                }
            },
        );

        patchEditorResizeHandlers(editor, {
            onResizing: () => {
                const targetFont = computeFreeTextResizeTargetFont(editor);
                if (targetFont === null) {
                    return;
                }
                if (!resizeStartSnapshots.has(editor)) {
                    resizeStartSnapshots.set(editor, captureResizeSnapshot(
                        editor,
                        getFreeTextEditorFontSize(editor) ?? targetFont,
                    ));
                }
                applyFreeTextInternalFontSize(editor, targetFont);
                updateFreeTextResizerSize(editor);
            },
            onResized: () => {
                const nextFont = computeFreeTextResizeTargetFont(editor);
                if (nextFont === null) {
                    return;
                }
                const targetFont = Math.round(nextFont);
                const before = resizeStartSnapshots.get(editor);
                resizeStartSnapshots.delete(editor);
                applyFreeTextInternalFontSize(editor, targetFont);
                updateFreeTextResizerSize(editor);
                scheduleFreeTextFontSync(editor, targetFont);
                if (before && registerHistoryCommand) {
                    const after = captureResizeSnapshot(editor, targetFont);
                    const key = editorHistoryKey(editor);
                    registerHistoryCommand({
                        cmd: () => {
                            const currentEditor = resolveCurrentEditor(key);
                            if (currentEditor) applyResizeSnapshot(currentEditor, after);
                        },
                        undo: () => {
                            const currentEditor = resolveCurrentEditor(key);
                            if (currentEditor) applyResizeSnapshot(currentEditor, before);
                        },
                    });
                }
            },
        });

        editorState.freeTextResizeHookPatched = true;
    }

    function shouldResetFreeTextDimensionsForFontChange(editor: IPdfjsEditor, value: unknown) {
        if (!editor.div) {
            return false;
        }
        const currentFont = getFreeTextEditorFontSize(editor);
        return !currentFont || Math.abs(currentFont - Number(value)) >= 0.5;
    }

    function resetFreeTextDimensions(editor: IPdfjsEditor) {
        if (!editor.div) {
            return;
        }
        editor.div.style.width = '';
        editor.div.style.height = '';
    }

    function computeFreeTextResizeTargetFont(editor: IPdfjsEditor) {
        const ratio = getPdfjsEditorFacadeState(editor).freeTextFontToWidthRatio;
        const w = editor.width;
        if (!ratio || !w || w <= 0) {
            return null;
        }
        return Math.max(
            FREE_TEXT_FONT_SIZE_MIN,
            Math.min(FREE_TEXT_FONT_SIZE_MAX, ratio * w),
        );
    }

    function applyFreeTextInternalFontSize(editor: IPdfjsEditor, targetFont: number) {
        const internal = editor.div?.querySelector<HTMLElement>('.internal');
        if (internal) {
            internal.style.fontSize = `calc(${targetFont}px * var(--total-scale-factor))`;
        }
    }

    function scheduleFreeTextFontSync(
        editor: IPdfjsEditor,
        targetFont: number,
    ) {
        if (disposed) {
            return;
        }
        const editorState = getPdfjsEditorFacadeState(editor);
        if (editorState.freeTextResizeSyncRaf !== undefined) {
            cancelAnimationFrame(editorState.freeTextResizeSyncRaf);
        }
        const editorRef = new WeakRef(editor);
        const frame = requestAnimationFrame(() => {
            pendingFreeTextResizeSyncFrames.delete(frame);
            const currentEditor = editorRef.deref();
            if (!currentEditor) {
                return;
            }
            getPdfjsEditorFacadeState(currentEditor).freeTextResizeSyncRaf = undefined;
            if (
                !disposed
                && syncInternalFontSize(currentEditor, targetFont)
            ) {
                emitAnnotationSetting({
                    key: 'textSize',
                    value: targetFont,
                });
            }
        });
        pendingFreeTextResizeSyncFrames.add(frame);
        editorState.freeTextResizeSyncRaf = frame;
    }

    function syncInternalFontSize(
        editor: IPdfjsEditor,
        targetFont: number,
    ) {
        const uiManager = getAnnotationUiManager();
        if (disposed || !editor.div?.isConnected || !uiManager) {
            return false;
        }

        try {
            const savedX = editor.x;
            const savedY = editor.y;
            const savedW = editor.width;
            const savedH = editor.height;

            const editorState = getPdfjsEditorFacadeState(editor);
            editorState.freeTextIsResizeSync = true;
            try {
                if (!updateEditorParams(editor, AnnotationEditorParamsType.FREETEXT_SIZE, targetFont)) {
                    setSelectedEditor(uiManager, editor);
                    updatePdfjsAnnotationManagerParams(
                        uiManager,
                        AnnotationEditorParamsType.FREETEXT_SIZE,
                        targetFont,
                    );
                }
            } finally {
                editorState.freeTextIsResizeSync = false;
            }

            if (savedX !== undefined) {
                editor.x = savedX;
            }
            if (savedY !== undefined) {
                editor.y = savedY;
            }
            if (savedW !== undefined) {
                editor.width = savedW;
            }
            if (savedH !== undefined) {
                editor.height = savedH;
            }
            refreshEditorLayout(editor);

            emitAnnotationModified();
            scheduleAnnotationCommentsSync();
            return true;
        } catch (error) {
            BrowserLogger.warn('pdf-viewer', 'Failed to sync FreeText font size', error);
            return false;
        }
    }

    function refreshFreeTextFontRatio(editor: IPdfjsEditor) {
        const fontSize = getFreeTextEditorFontSize(editor);
        const w = editor.width;
        if (!fontSize || fontSize <= 0 || typeof w !== 'number' || w <= 0.01) {
            return;
        }
        const freshRatio = fontSize / w;
        const editorState = getPdfjsEditorFacadeState(editor);
        const existingRatio = editorState.freeTextFontToWidthRatio;
        if (!existingRatio || Math.abs(freshRatio - existingRatio) / freshRatio > 0.5) {
            editorState.freeTextFontToWidthRatio = freshRatio;
        }
    }

    function markFreeTextResizable(editor: IPdfjsEditor) {
        try {
            markEditorResizable(editor);
            const editorState = getPdfjsEditorFacadeState(editor);
            editorState.freeTextResizablePatched = true;
        } catch {
            // Ignore if PDF.js internals reject instance patching.
        }
    }

    function ensureFreeTextEditorCanResize(editor: IPdfjsEditor) {
        if (!editor || detectEditorSubtype(editor) !== 'Typewriter') {
            return;
        }
        if (getPdfjsEditorFacadeState(editor).freeTextResizablePatched) {
            refreshFreeTextFontRatio(editor);
            ensureFreeTextEditorInteractivity(editor);
            return;
        }

        markFreeTextResizable(editor);
        patchFreeTextResizeFontSync(editor);
        ensureFreeTextEditorInteractivity(editor);
    }

    function patchResizableFreeTextEditors(uiManager: AnnotationEditorUIManager) {
        for (let pageIndex = 0; pageIndex < getNumPages(); pageIndex += 1) {
            for (const editor of getEditorsOnPage(uiManager, pageIndex)) {
                ensureFreeTextEditorCanResize(editor);
            }
        }
    }

    tryOnScopeDispose(() => {
        disposed = true;
        cancelPendingFreeTextFontSyncs();
        cleanupResizeCursor();
    });

    return {
        ensureFreeTextEditorCanResize,
        patchResizableFreeTextEditors,
        getFreeTextEditorFontSize,
    };
};
