import { AnnotationEditorParamsType } from '@app/services/pdfjs/runtime-lib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationSettings } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { detectEditorSubtype } from '@app/composables/pdf/pdfAnnotationEditorUtils';
import {
    getEditorsOnPage,
    setSelectedEditor,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browser-logger';

const FREE_TEXT_FONT_SIZE_MIN = 8;
const FREE_TEXT_FONT_SIZE_MAX = 96;

type TFreeTextResizableEditor = IPdfjsEditor & {
    __freeTextResizablePatched?: boolean;
    __freeTextFontToWidthRatio?: number;
    makeResizable?: () => void;
};

type TFreeTextResizeHookEditor = IPdfjsEditor & {
    __freeTextResizeHookPatched?: boolean;
    __freeTextFontToWidthRatio?: number;
    __freeTextResizeSyncRaf?: number;
    __freeTextIsResizeSync?: boolean;
};

interface IUseFreeTextResizeOptions {
    getAnnotationUiManager: () => AnnotationEditorUIManager | null;
    getNumPages: () => number;
    emitAnnotationModified: () => void;
    emitAnnotationSetting: (payload: {
        key: keyof IAnnotationSettings;
        value: IAnnotationSettings[keyof IAnnotationSettings];
    }) => void;
    scheduleAnnotationCommentsSync: () => void;
}

export function useFreeTextResize(options: IUseFreeTextResizeOptions) {
    const {
        getAnnotationUiManager,
        getNumPages,
        emitAnnotationModified,
        emitAnnotationSetting,
        scheduleAnnotationCommentsSync,
    } = options;

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
        const serialized = (editor as { serialize?: () => unknown }).serialize?.();
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
        const nextSize = Math.max(4, Math.min(10, maxCornerSize));
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
                document.documentElement.classList.add(cursorClass);
                const cleanup = () => {
                    document.documentElement.classList.remove(cursorClass);
                    window.removeEventListener('pointerup', cleanup);
                    window.removeEventListener('blur', cleanup);
                };
                window.addEventListener('pointerup', cleanup);
                window.addEventListener('blur', cleanup);
            });
        }
    }

    function patchFreeTextPreSelect(editor: IPdfjsEditor) {
        const tagged = editor as IPdfjsEditor & { __evbPreSelectPatched?: boolean };
        if (tagged.__evbPreSelectPatched) {
            return;
        }
        tagged.__evbPreSelectPatched = true;

        const div = editor.div;
        if (!div) {
            return;
        }

        div.addEventListener('pointerdown', handleFreeTextPreSelectPointerDown(editor), { capture: true });
    }

    function canPreSelectFreeTextEditor(editor: IPdfjsEditor, event: PointerEvent) {
        if (event.button !== 0) {
            return false;
        }
        if (typeof editor.isInEditMode === 'function' && editor.isInEditMode()) {
            return false;
        }
        return Boolean(editor._isDraggable && !editor.isSelected);
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

    function isActualNaN(value: unknown): boolean {
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
        const editorWithDims = editor as IPdfjsEditor & { parentDimensions?: number[] };
        const parentDims = editorWithDims.parentDimensions;
        if (!parentDims || parentDims.length < 2) {
            return null;
        }
        return {
            parentW: parentDims[0] ?? 0,
            parentH: parentDims[1] ?? 0,
        };
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
        const tagged = editor as IPdfjsEditor & { makeResizable?: () => void };
        const div = editor.div;
        if (!div) {
            return;
        }

        const isEditing = typeof editor.isInEditMode === 'function' && editor.isInEditMode();

        recoverNaNPosition(editor);
        recoverNaNDimensions(editor);

        if (!isEditing) {
            if (typeof tagged.makeResizable === 'function') {
                tagged.makeResizable();
            }
            editor._isDraggable = true;
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
        const tagged = editor as TFreeTextResizeHookEditor;
        if (tagged.__freeTextResizeHookPatched) {
            return;
        }

        function captureRatio() {
            refreshFreeTextFontRatio(editor, tagged);
        }
        captureRatio();

        const originalUpdateParams = typeof editor.updateParams === 'function'
            ? editor.updateParams.bind(editor) : null;
        if (originalUpdateParams) {
            editor.updateParams = (type: number, value: unknown) => {
                const isExternalFontChange
                    = type === AnnotationEditorParamsType.FREETEXT_SIZE
                    && !tagged.__freeTextIsResizeSync;
                if (isExternalFontChange && shouldResetFreeTextDimensionsForFontChange(editor, value)) {
                    resetFreeTextDimensions(editor);
                }
                originalUpdateParams(type, value);
                if (isExternalFontChange) {
                    refreshFreeTextFontRatio(editor, tagged);
                }
            };
        }

        const originalOnResizing = typeof editor._onResizing === 'function'
            ? editor._onResizing.bind(editor)
            : null;

        editor._onResizing = () => {
            originalOnResizing?.();
            const targetFont = computeFreeTextResizeTargetFont(tagged, editor);
            if (targetFont === null) {
                return;
            }
            applyFreeTextInternalFontSize(editor, targetFont);
            updateFreeTextResizerSize(editor);
        };

        const originalOnResized = typeof editor._onResized === 'function'
            ? editor._onResized.bind(editor)
            : null;

        editor._onResized = () => {
            originalOnResized?.();
            const nextFont = computeFreeTextResizeTargetFont(tagged, editor);
            if (nextFont === null) {
                return;
            }
            const targetFont = Math.round(nextFont);
            applyFreeTextInternalFontSize(editor, targetFont);
            updateFreeTextResizerSize(editor);
            scheduleFreeTextFontSync(editor, tagged, targetFont);
        };

        tagged.__freeTextResizeHookPatched = true;
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

    function computeFreeTextResizeTargetFont(tagged: TFreeTextResizeHookEditor, editor: IPdfjsEditor) {
        const ratio = tagged.__freeTextFontToWidthRatio;
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
        tagged: TFreeTextResizeHookEditor,
        targetFont: number,
    ) {
        if (tagged.__freeTextResizeSyncRaf) {
            cancelAnimationFrame(tagged.__freeTextResizeSyncRaf);
        }
        tagged.__freeTextResizeSyncRaf = requestAnimationFrame(() => {
            tagged.__freeTextResizeSyncRaf = undefined;
            syncInternalFontSize(editor, tagged, targetFont);
            emitAnnotationSetting({
                key: 'textSize',
                value: targetFont,
            });
        });
    }

    function syncInternalFontSize(
        editor: IPdfjsEditor,
        tagged: IPdfjsEditor & { __freeTextIsResizeSync?: boolean },
        targetFont: number,
    ) {
        const uiManager = getAnnotationUiManager();
        if (!editor.div?.isConnected || !uiManager) {
            return;
        }

        try {
            const savedX = editor.x;
            const savedY = editor.y;
            const savedW = editor.width;
            const savedH = editor.height;

            tagged.__freeTextIsResizeSync = true;
            try {
                if (typeof editor.updateParams === 'function') {
                    editor.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, targetFont);
                } else {
                    setSelectedEditor(uiManager, editor);
                    uiManager.updateParams(AnnotationEditorParamsType.FREETEXT_SIZE, targetFont);
                }
            } finally {
                tagged.__freeTextIsResizeSync = false;
            }

            editor.x = savedX;
            editor.y = savedY;
            editor.width = savedW;
            editor.height = savedH;
            editor.setDims?.();
            editor.fixAndSetPosition?.();

            emitAnnotationModified();
            scheduleAnnotationCommentsSync();
        } catch (error) {
            BrowserLogger.warn('pdf-viewer', 'Failed to sync FreeText font size', error);
        }
    }

    function refreshFreeTextFontRatio(editor: IPdfjsEditor, tagged: TFreeTextResizableEditor) {
        const fontSize = getFreeTextEditorFontSize(editor);
        const w = editor.width;
        if (!fontSize || fontSize <= 0 || typeof w !== 'number' || w <= 0.01) {
            return;
        }
        const freshRatio = fontSize / w;
        const existingRatio = tagged.__freeTextFontToWidthRatio;
        if (!existingRatio || Math.abs(freshRatio - existingRatio) / freshRatio > 0.5) {
            tagged.__freeTextFontToWidthRatio = freshRatio;
        }
    }

    function markFreeTextResizable(editor: IPdfjsEditor, tagged: TFreeTextResizableEditor) {
        try {
            Object.defineProperty(editor, 'isResizable', {
                configurable: true,
                get() {
                    return true;
                },
            });
            tagged.__freeTextResizablePatched = true;
        } catch {
            // Ignore if PDF.js internals reject instance patching.
        }
    }

    function ensureFreeTextEditorCanResize(editor: IPdfjsEditor) {
        if (!editor || detectEditorSubtype(editor) !== 'Typewriter') {
            return;
        }
        const tagged = editor as TFreeTextResizableEditor;
        if (tagged.__freeTextResizablePatched) {
            refreshFreeTextFontRatio(editor, tagged);
            ensureFreeTextEditorInteractivity(editor);
            return;
        }

        markFreeTextResizable(editor, tagged);
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

    return {
        ensureFreeTextEditorCanResize,
        patchResizableFreeTextEditors,
        getFreeTextEditorFontSize,
    };
}
