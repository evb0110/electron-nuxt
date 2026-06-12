import {
    AnnotationEditorParamsType,
    AnnotationEditorType,
} from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import { delay } from 'es-toolkit/promise';
import { range } from 'es-toolkit/math';
import type {
    IAnnotationMarkerRect,
    IAnnotationSettings,
    ITextMarkupAnnotationProperties,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IMarkupSubtypeHint } from '@app/modules/pdf-viewer/engine/pdf-serialization-subtype-hints/pdfSerializationSubtypeHintsTypes';
import { isAuthoringAnnotationTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isAuthoringAnnotationTool';
import { isSelectionMarkupTool } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/isSelectionMarkupTool';
import { shouldForceTextMarkup } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/shouldForceTextMarkup';
import { toolToMarkupSubtype } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/toolToMarkupSubtype';
import type {
    IPdfjsEditor,
    IPdfjsHighlightBox,
} from '@app/types/pdfjs';
import { errorToLogText } from '@app/modules/pdf-viewer/engine/annotation-css-utils/errorToLogText';
import { toCssColor } from '@app/modules/pdf-viewer/engine/annotation-css-utils/toCssColor';
import {
    clearSelectedEditorState,
    getActiveEditor,
    getEditorsOnPage,
    updateEditorDefaultParams,
} from '@app/services/pdfjs/annotationEditorAdapter';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { createPdfHighlightEditorClassPatch } from '@app/services/pdfjs/createPdfHighlightEditorClassPatch';
import { createAnnotationMarkupSubtypeDrawLayer } from '@app/modules/pdf-viewer/engine/annotations/annotation-markup-subtype-draw-layer/createAnnotationMarkupSubtypeDrawLayer';
import { findClosestHighlightDrawLayerSvg } from '@app/modules/pdf-viewer/engine/annotations/annotation-markup-subtype-draw-layer/findClosestHighlightDrawLayerSvg';
import { resolveEditorHighlightClipPathId } from '@app/modules/pdf-viewer/engine/annotations/annotation-markup-subtype-draw-layer/resolveEditorHighlightClipPathId';
import { createAnnotationEditorPresentation } from '@app/modules/pdf-viewer/engine/annotations/annotation-editor-presentation/createAnnotationEditorPresentation';
import { toOpaqueHighlightDisplayColor } from '@app/modules/pdf-viewer/engine/text-markup-color/toOpaqueHighlightDisplayColor';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { BrowserLogger } from '@app/utils/browserLogger';

const ANNOTATION_MODE_RETRY_RENDER_WAIT_TIMEOUT_MS = 500;

const OPAQUE_HIGHLIGHT_OPACITY = 1;

type TAnnotationEditorMode = Parameters<AnnotationEditorUIManager['updateMode']>[0];

const ANNOTATION_TOOL_MODES: Partial<Record<TAnnotationTool, TAnnotationEditorMode>> = {
    text: AnnotationEditorType.FREETEXT,
    stamp: AnnotationEditorType.STAMP,
};

interface IUseAnnotationToolStateOptions {
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    annotationCursorMode: Ref<boolean>;
    annotationKeepActive: Ref<boolean>;
    annotationSettings: Ref<IAnnotationSettings | null>;
    numPages: Ref<number>;
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getFreeTextResize: () => {patchResizableFreeTextEditors: (mgr: AnnotationEditorUIManager) => void;};
    emitAnnotationToolAutoReset: () => void;
}

interface IMarkupSubtypeGeometryHintEntry {
    editor: IPdfjsEditor;
    hint: IMarkupSubtypeHint;
}

export const useAnnotationToolState = (options: IUseAnnotationToolStateOptions) => {
    const {
        annotationUiManager,
        currentPage,
        annotationTool,
        annotationKeepActive,
        annotationSettings,
        numPages,
        getEditorIdentity,
        getFreeTextResize,
        emitAnnotationToolAutoReset,
    } = options;

    const pendingAnnotationTool = ref<TAnnotationTool>(annotationTool.value);
    const pendingAnnotationSettings = ref<IAnnotationSettings | null>(null);
    let annotationToolUpdateToken = 0;
    let annotationToolUpdatePromise: Promise<void> = Promise.resolve();

    const markupSubtypeOverrides = new Map<string, TMarkupSubtype>();
    const editorMarkupSubtypeOverrides = new Map<string, TMarkupSubtype>();
    const markupSubtypeColorOverrides = new Map<string, string>();
    const markupSubtypeGeometryHints = new Map<string, IMarkupSubtypeGeometryHintEntry>();
    const forgottenMaterializedMarkupSubtypeAnnotationIds = new Set<string>();
    let editorObjectMarkupSubtypeOverrides = new WeakMap<IPdfjsEditor, TMarkupSubtype>();
    let editorObjectMarkupSubtypeColorOverrides = new WeakMap<IPdfjsEditor, string>();
    let lastSelectedMarkupEditor: {
        editor: IPdfjsEditor;
        pageIndex: number;
        subtype: TMarkupSubtype;
    } | null = null;
    const markupSubtypeDrawLayer = createAnnotationMarkupSubtypeDrawLayer();
    const {
        resolveEditorDrawLayerHighlight,
        recolorEditorHighlightDrawLayer,
        suppressEditorHighlightDrawLayerFill,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
    } = markupSubtypeDrawLayer;
    const {
        clearMarkupSubtypeEditorClass,
        applyEditorMarkupSubtypePresentation: applyEditorMarkupSubtypePresentationForPage,
        resolveEditorSubtypeFromPresentation,
    } = createAnnotationEditorPresentation({
        resolveEditorMarkupSubtypeHintRect,
        resolveEditorMarkupSubtypeColor,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
    });

    function applyEditorMarkupSubtypePresentation(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        pageIndex = currentPage.value - 1,
    ) {
        applyEditorMarkupSubtypePresentationForPage(editor, subtype, pageIndex);
    }

    function refreshEditorTextMarkupColor(
        editor: IPdfjsEditor,
        color: string,
        subtype: TMarkupSubtype,
        pageIndex = currentPage.value - 1,
    ) {
        // PDF.js may recreate its base highlight SVG when color changes, so run
        // its refresh first and then reapply our subtype-specific presentation.
        editor.onUpdatedColor?.();
        applyEditorMarkupSubtypePresentation(editor, subtype, pageIndex);
        if (subtype === 'Highlight') {
            recolorEditorHighlightDrawLayer(editor, color);
            return;
        }
        suppressEditorHighlightDrawLayerFill(editor);
    }

    function isFinitePositiveRect(rect: IAnnotationMarkerRect | null | undefined): rect is IAnnotationMarkerRect {
        return Boolean(
            rect
            && Number.isFinite(rect.left)
            && Number.isFinite(rect.top)
            && Number.isFinite(rect.width)
            && Number.isFinite(rect.height)
            && rect.width > 0
            && rect.height > 0,
        );
    }

    function rectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
        const rect = {
            left: editor.x ?? Number.NaN,
            top: editor.y ?? Number.NaN,
            width: editor.width ?? Number.NaN,
            height: editor.height ?? Number.NaN,
        };
        return isFinitePositiveRect(rect) ? rect : null;
    }

    function rectFromMarkupBoxes(boxes: readonly IPdfjsHighlightBox[] | null | undefined): IAnnotationMarkerRect | null {
        if (!boxes?.length) {
            return null;
        }
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;

        for (const box of boxes) {
            if (
                !Number.isFinite(box.x)
                || !Number.isFinite(box.y)
                || !Number.isFinite(box.width)
                || !Number.isFinite(box.height)
                || box.width <= 0
                || box.height <= 0
            ) {
                continue;
            }
            left = Math.min(left, box.x);
            top = Math.min(top, box.y);
            right = Math.max(right, box.x + box.width);
            bottom = Math.max(bottom, box.y + box.height);
        }

        const rect = {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
        return isFinitePositiveRect(rect) ? rect : null;
    }

    function resolveEditorMarkupSubtypeHintRect(editor: IPdfjsEditor) {
        return rectFromEditor(editor) ?? rectFromMarkupBoxes(editor.__evbMarkupBoxes);
    }

    function elementHasClass(element: HTMLElement | null | undefined, className: string) {
        const classList = element?.classList;
        if (!classList) {
            return false;
        }
        if (typeof classList.contains === 'function') {
            return classList.contains(className);
        }
        return Array.from(classList).includes(className);
    }

    function isMarkupEditorCandidate(editor: IPdfjsEditor, pageIndex: number) {
        return elementHasClass(editor.div, 'highlightEditor')
            || Boolean(editor.__evbMarkupBoxes?.length)
            || Boolean(resolveEditorMarkupSubtypeOverride(editor, pageIndex))
            || Boolean(resolveEditorSubtypeFromPresentation(editor));
    }

    function resolveEditorPageMarkupIndex(editor: IPdfjsEditor, pageIndex: number, identity: string) {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return null;
        }

        let pageMarkupIndex = 0;
        for (const candidate of getEditorsOnPage(uiManager, pageIndex)) {
            if (!isMarkupEditorCandidate(candidate, pageIndex)) {
                continue;
            }
            const candidateIdentity = getEditorIdentity(candidate, pageIndex);
            const matchingAnnotationId = Boolean(
                editor.annotationElementId
                && candidate.annotationElementId
                && editor.annotationElementId === candidate.annotationElementId,
            );
            if (candidate === editor || candidateIdentity === identity || matchingAnnotationId) {
                return pageMarkupIndex;
            }
            pageMarkupIndex += 1;
        }

        return null;
    }

    function isDeletedMarkupSubtypeEditor(editor: IPdfjsEditor) {
        return typeof editor.comment === 'object'
            && editor.comment !== null
            && editor.comment.deleted === true;
    }

    function isEditorElementDisconnected(editor: IPdfjsEditor) {
        return Boolean(editor.div && 'isConnected' in editor.div && !editor.div.isConnected);
    }

    function isLiveMarkupSubtypeHintEntry(identity: string, entry: IMarkupSubtypeGeometryHintEntry) {
        const {
            editor,
            hint,
        } = entry;
        if (isDeletedMarkupSubtypeEditor(editor) || isEditorElementDisconnected(editor)) {
            return false;
        }

        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return true;
        }
        return getEditorsOnPage(uiManager, hint.pageIndex).some((candidate) => {
            const matchingAnnotationId = Boolean(
                editor.annotationElementId
                && candidate.annotationElementId
                && editor.annotationElementId === candidate.annotationElementId,
            );
            return candidate === editor
                || getEditorIdentity(candidate, hint.pageIndex) === identity
                || matchingAnnotationId;
        });
    }

    function getAnnotationMode(tool: TAnnotationTool) {
        return ANNOTATION_TOOL_MODES[tool] ?? AnnotationEditorType.NONE;
    }

    function resolveMarkupSubtypeColor(subtype: TMarkupSubtype) {
        const settings = annotationSettings.value;
        if (subtype === 'Underline') {
            return settings?.underlineColor ?? '#2563eb';
        }
        if (subtype === 'StrikeOut') {
            return settings?.strikethroughColor ?? '#dc2626';
        }
        if (subtype === 'Squiggly') {
            return settings?.squigglyColor ?? '#16a34a';
        }
        return settings?.highlightColor ?? '#ffd400';
    }

    function resolveEditorColor(editor: IPdfjsEditor) {
        return toCssColor(editor.color, editor.opacity ?? 1);
    }

    function getEditorMarkupSubtypeColorKey(editor: IPdfjsEditor, pageIndex: number) {
        return getEditorIdentity(editor, pageIndex);
    }

    function storeEditorMarkupSubtypeColor(editor: IPdfjsEditor, pageIndex: number, color: string) {
        editor.__evbMarkupSubtypeColor = color;
        editorObjectMarkupSubtypeColorOverrides.set(editor, color);
        markupSubtypeColorOverrides.set(getEditorMarkupSubtypeColorKey(editor, pageIndex), color);
        if (editor.annotationElementId) {
            markupSubtypeColorOverrides.set(editor.annotationElementId, color);
        }
    }

    function rememberMarkupSubtypeColorOverride(
        annotationId: string | null | undefined,
        color: string | null | undefined,
    ) {
        const normalizedAnnotationId = normalizePdfJsAnnotationId(annotationId);
        const normalizedColor = color?.trim();
        if (!normalizedAnnotationId || !normalizedColor) {
            return;
        }
        forgottenMaterializedMarkupSubtypeAnnotationIds.delete(normalizedAnnotationId);
        markupSubtypeColorOverrides.set(normalizedAnnotationId, normalizedColor);
        if (annotationId) {
            markupSubtypeColorOverrides.set(annotationId, normalizedColor);
        }
    }

    function updateMarkupSubtypeGeometryHintColor(editor: IPdfjsEditor, pageIndex: number, color: string) {
        const identity = getEditorIdentity(editor, pageIndex);
        const entry = markupSubtypeGeometryHints.get(identity);
        if (!entry) {
            return;
        }
        markupSubtypeGeometryHints.set(identity, {
            ...entry,
            hint: {
                ...entry.hint,
                color,
            },
        });
    }

    function markExistingEditorAnnotationChanged(editor: IPdfjsEditor) {
        if (!editor.annotationElementId) {
            return;
        }
        const uiManager = (annotationUiManager.value ?? editor._uiManager) as { addChangedExistingAnnotation?: (editor: IPdfjsEditor) => unknown } | null | undefined;
        uiManager?.addChangedExistingAnnotation?.(editor);
    }

    function resolveEditorMarkupSubtypeColor(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype,
        pageIndex: number,
    ) {
        if (editor.annotationElementId) {
            const normalizedAnnotationId = normalizePdfJsAnnotationId(editor.annotationElementId);
            const annotationColor = markupSubtypeColorOverrides.get(editor.annotationElementId)
                ?? (normalizedAnnotationId ? markupSubtypeColorOverrides.get(normalizedAnnotationId) : undefined);
            if (annotationColor) {
                storeEditorMarkupSubtypeColor(editor, pageIndex, annotationColor);
                return annotationColor;
            }
        }
        const objectColor = editorObjectMarkupSubtypeColorOverrides.get(editor);
        if (objectColor) {
            return objectColor;
        }
        if (editor.__evbMarkupSubtypeColor) {
            return editor.__evbMarkupSubtypeColor;
        }
        const domColor = editor.div?.dataset.markupSubtypeColor;
        if (domColor) {
            storeEditorMarkupSubtypeColor(editor, pageIndex, domColor);
            return domColor;
        }
        const identityColor = markupSubtypeColorOverrides.get(getEditorMarkupSubtypeColorKey(editor, pageIndex));
        if (identityColor) {
            storeEditorMarkupSubtypeColor(editor, pageIndex, identityColor);
            return identityColor;
        }
        if (editor.__evbSelectionText?.trim()) {
            const fallbackColor = resolveMarkupSubtypeColor(subtype);
            storeEditorMarkupSubtypeColor(editor, pageIndex, fallbackColor);
            return fallbackColor;
        }
        const editorColor = resolveEditorColor(editor);
        if (editorColor) {
            storeEditorMarkupSubtypeColor(editor, pageIndex, editorColor);
            return editorColor;
        }
        const fallbackColor = resolveMarkupSubtypeColor(subtype);
        storeEditorMarkupSubtypeColor(editor, pageIndex, fallbackColor);
        return fallbackColor;
    }

    function resolveHighlightColorForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        switch (tool) {
            case 'underline':
                return settings.underlineColor;
            case 'strikethrough':
                return settings.strikethroughColor;
            case 'squiggly':
                return settings.squigglyColor;
            default:
                return settings.highlightColor;
        }
    }

    function resolveHighlightDisplayColorForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        const color = resolveHighlightColorForTool(settings, tool);
        if (tool !== 'highlight') {
            return color;
        }
        return toOpaqueHighlightDisplayColor(color, settings.highlightOpacity);
    }

    function resolveHighlightOpacityForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        switch (tool) {
            case 'underline':
                return settings.underlineOpacity;
            case 'strikethrough':
                return settings.strikethroughOpacity;
            case 'squiggly':
                return settings.squigglyOpacity;
            default:
                return OPAQUE_HIGHLIGHT_OPACITY;
        }
    }

    const {
        captureHighlightEditorClassFromTypes,
        syncHighlightDefaultOpacity,
        enforceHighlightDefaultsForNewEditor,
    } = createPdfHighlightEditorClassPatch({
        pendingAnnotationSettings,
        annotationTool,
        resolveHighlightOpacityForTool,
    });

    function resolveHighlightFreeForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        if (shouldForceTextMarkup(tool)) {
            return false;
        }
        return settings.highlightFreehandEnabled;
    }

    function hasSelectedPdfjsEditor(uiManager: AnnotationEditorUIManager) {
        return Boolean((uiManager as AnnotationEditorUIManager & { hasSelection?: boolean }).hasSelection);
    }

    function applyToolbarDefaultParam(
        uiManager: AnnotationEditorUIManager,
        type: Parameters<AnnotationEditorUIManager['updateParams']>[0],
        value: Parameters<AnnotationEditorUIManager['updateParams']>[1],
    ) {
        if (updateEditorDefaultParams(uiManager, Number(type), value)) {
            return;
        }

        clearSelectedEditorState(uiManager);
        if (!hasSelectedPdfjsEditor(uiManager)) {
            uiManager.updateParams(type, value);
            return;
        }

        BrowserLogger.warn(
            'annotations',
            'Skipped toolbar default annotation parameter update because PDF.js kept a selected editor after clear.',
        );
    }

    function applyHighlightParamsForTool(
        uiManager: AnnotationEditorUIManager,
        settings: IAnnotationSettings,
        tool: TAnnotationTool,
    ) {
        syncHighlightDefaultOpacity(resolveHighlightOpacityForTool(settings, tool));
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.HIGHLIGHT_COLOR, resolveHighlightDisplayColorForTool(settings, tool));
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, settings.highlightThickness);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.HIGHLIGHT_FREE, resolveHighlightFreeForTool(settings, tool));
        uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL, settings.showAllHighlights);
    }

    function applyAnnotationSettings(settings: IAnnotationSettings | null) {
        pendingAnnotationSettings.value = settings;
        const uiManager = annotationUiManager.value;
        if (!uiManager || !settings) {
            return;
        }

        const tool = annotationTool.value;
        applyHighlightParamsForTool(uiManager, settings, tool);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.INK_COLOR, settings.inkColor);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.INK_OPACITY, settings.inkOpacity);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.INK_THICKNESS, settings.inkThickness);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.FREETEXT_COLOR, settings.textColor);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.FREETEXT_SIZE, settings.textSize);
        getFreeTextResize().patchResizableFreeTextEditors(uiManager);
        syncMarkupSubtypePresentationForEditors();
    }

    async function waitForEditorsRenderedBeforeModeRetry(
        uiManager: AnnotationEditorUIManager,
        pageNumber: number,
    ) {
        const timeoutController = new AbortController();
        try {
            await Promise.race([
                uiManager.waitForEditorsRendered(Math.max(1, pageNumber)),
                delay(ANNOTATION_MODE_RETRY_RENDER_WAIT_TIMEOUT_MS, { signal: timeoutController.signal }).then(() => {
                    throw new Error('Timed out waiting for editors before annotation mode retry');
                }),
            ]);
        } finally {
            timeoutController.abort();
        }
    }

    async function updateModeWithRetry(
        uiManager: AnnotationEditorUIManager,
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber = currentPage.value,
    ) {
        try {
            await uiManager.updateMode(mode);
            return null;
        } catch (initialError) {
            BrowserLogger.debug('annotations', `Annotation mode switch will retry: ${errorToLogText(initialError)}`);
            try {
                await waitForEditorsRenderedBeforeModeRetry(uiManager, pageNumber);
            } catch (waitError) {
                BrowserLogger.debug('annotations', `Failed to wait for editor render before mode retry: ${errorToLogText(waitError)}`);
            }
            await nextTick();
        }

        try {
            await uiManager.updateMode(mode);
            return null;
        } catch (retryError) {
            return retryError;
        }
    }

    function syncAnnotationEditorLayerVisibility(
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
    ) {
        if (typeof document === 'undefined' || mode === AnnotationEditorType.NONE) {
            return;
        }
        const layers = document.querySelectorAll<HTMLElement>(
            '.annotation-editor-layer, .annotationEditorLayer',
        );
        layers.forEach((layer) => {
            if (layer.hidden) {
                layer.hidden = false;
            }
        });
    }

    async function setAnnotationTool(tool: TAnnotationTool) {
        pendingAnnotationTool.value = tool;
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return;
        }
        const localToken = ++annotationToolUpdateToken;

        annotationToolUpdatePromise = annotationToolUpdatePromise.then(async () => {
            if (annotationToolUpdateToken !== localToken) {
                return;
            }

            const effectiveTool = pendingAnnotationTool.value;
            const mode = getAnnotationMode(effectiveTool);
            const settings = pendingAnnotationSettings.value;

            if (settings) {
                applyHighlightParamsForTool(uiManager, settings, effectiveTool);
            }

            const modeError = await updateModeWithRetry(uiManager, mode, currentPage.value);
            if (modeError) {
                BrowserLogger.warn('annotations', `Failed to update annotation tool mode: ${errorToLogText(modeError)}`);
                return;
            }

            syncAnnotationEditorLayerVisibility(mode);

            if (annotationToolUpdateToken !== localToken || !settings) {
                return;
            }

            applyAnnotationSettings(settings);
            getFreeTextResize().patchResizableFreeTextEditors(uiManager);
        }).catch((error: unknown) => {
            BrowserLogger.warn('annotations', 'Failed to apply annotation tool update', error);
        });

        await annotationToolUpdatePromise;
    }

    function getToolUpdatePromise() {
        return annotationToolUpdatePromise;
    }

    function maybeAutoResetAnnotationTool() {
        if (annotationKeepActive.value) {
            return;
        }
        if (!isAuthoringAnnotationTool(annotationTool.value)) {
            return;
        }
        // Selection-markup tools only fire when the user makes a text selection, so they cannot
        // misfire. Auto-resetting them to NONE hands pointer ownership to the annotation layer,
        // which blocks subsequent selections and turns the cursor into a pointer over saved
        // highlights. Keep them active across creations.
        if (isSelectionMarkupTool(annotationTool.value)) {
            return;
        }
        queueMicrotask(() => {
            emitAnnotationToolAutoReset();
        });
    }

    function syncMarkupSubtypePresentationForEditors() {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return;
        }
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
                const subtype = (
                    resolveEditorMarkupSubtypeOverride(normalizedEditor, pageIndex)
                    ?? resolveEditorSubtypeFromPresentation(normalizedEditor)
                );
                applyEditorMarkupSubtypePresentation(normalizedEditor, subtype, pageIndex);
            }
        }
    }

    function resolveInitialMarkupSubtypeColor(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype,
        options?: { preferEditorColor?: boolean },
    ) {
        if (editor.__evbMarkupSubtypeColor) {
            return editor.__evbMarkupSubtypeColor;
        }
        const domColor = editor.div?.dataset.markupSubtypeColor;
        if (domColor) {
            return domColor;
        }
        if (options?.preferEditorColor === false) {
            // Creation from an active subtype tool should use that tool's saved
            // color, not the transient generic Highlight editor color.
            return resolveMarkupSubtypeColor(subtype);
        }
        if (subtype === 'Highlight') {
            return resolveEditorColor(editor) ?? resolveMarkupSubtypeColor(subtype);
        }
        return resolveEditorColor(editor) ?? resolveMarkupSubtypeColor(subtype);
    }

    function setEditorMarkupSubtypeOverride(
        editor: IPdfjsEditor,
        pageIndex: number,
        subtype: TMarkupSubtype,
        options?: { preferEditorColor?: boolean },
    ) {
        editorObjectMarkupSubtypeOverrides.set(editor, subtype);
        const identity = getEditorIdentity(editor, pageIndex);
        editorMarkupSubtypeOverrides.set(identity, subtype);
        if (editor.annotationElementId) {
            const normalizedAnnotationId = normalizePdfJsAnnotationId(editor.annotationElementId);
            if (normalizedAnnotationId) {
                forgottenMaterializedMarkupSubtypeAnnotationIds.delete(normalizedAnnotationId);
            }
            markupSubtypeOverrides.set(editor.annotationElementId, subtype);
        }
        const color = resolveInitialMarkupSubtypeColor(editor, subtype, options);
        const visualColor = resolveTextMarkupVisualColor(subtype, color);
        editor.color = visualColor;
        if (subtype === 'Highlight') {
            editor.opacity = OPAQUE_HIGHLIGHT_OPACITY;
        }
        const markerRect = resolveEditorMarkupSubtypeHintRect(editor);
        if (markerRect) {
            markupSubtypeGeometryHints.set(identity, {
                editor,
                hint: {
                    annotationId: editor.annotationElementId ?? null,
                    color,
                    id: identity,
                    subtype,
                    pageIndex,
                    markerRect,
                    consumed: false,
                    pageMarkupIndex: resolveEditorPageMarkupIndex(editor, pageIndex, identity),
                    source: 'editor-live',
                },
            });
        }
        storeEditorMarkupSubtypeColor(editor, pageIndex, color);
        refreshEditorTextMarkupColor(editor, visualColor, subtype, pageIndex);
        editor.addToAnnotationStorage?.();
    }

    function findSelectedMarkupEditor(): {
        editor: IPdfjsEditor;
        pageIndex: number;
        subtype: TMarkupSubtype;
    } | null {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return null;
        }

        const activeEditor = getActiveEditor(uiManager);
        const candidates = activeEditor
            ? [activeEditor]
            : range(numPages.value).flatMap(pageIndex => getEditorsOnPage(uiManager, pageIndex));

        for (const editor of candidates) {
            const pageIndex = Number.isFinite(editor.parentPageIndex)
                ? Math.max(0, editor.parentPageIndex as number)
                : Math.max(0, currentPage.value - 1);
            const isSelected = activeEditor === editor
                || editor.isSelected === true
                || editor.div?.classList.contains('selectedEditor') === true
                || editor.div?.classList.contains('selected') === true;
            if (!isSelected) {
                continue;
            }

            const subtype = resolveEditorMarkupSubtypeOverride(editor, pageIndex)
                ?? resolveEditorSubtypeFromPresentation(editor)
                ?? (elementHasClass(editor.div, 'highlightEditor') ? 'Highlight' : null);
            if (subtype) {
                const selected = {
                    editor,
                    pageIndex,
                    subtype,
                };
                lastSelectedMarkupEditor = selected;
                return selected;
            }
        }

        return null;
    }

    function getLiveLastSelectedMarkupEditor() {
        if (!lastSelectedMarkupEditor) {
            return null;
        }
        const {
            editor,
            pageIndex,
        } = lastSelectedMarkupEditor;
        if (isDeletedMarkupSubtypeEditor(editor) || isEditorElementDisconnected(editor)) {
            lastSelectedMarkupEditor = null;
            return null;
        }
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return lastSelectedMarkupEditor;
        }
        const identity = getEditorIdentity(editor, pageIndex);
        const isStillManaged = getEditorsOnPage(uiManager, pageIndex).some((candidate) => {
            const matchingAnnotationId = Boolean(
                editor.annotationElementId
                && candidate.annotationElementId
                && editor.annotationElementId === candidate.annotationElementId,
            );
            return candidate === editor
                || getEditorIdentity(candidate, pageIndex) === identity
                || matchingAnnotationId;
        });
        if (!isStillManaged) {
            lastSelectedMarkupEditor = null;
            return null;
        }
        return lastSelectedMarkupEditor;
    }

    function getSelectedTextMarkupAnnotationProperties(): ITextMarkupAnnotationProperties | null {
        const selected = findSelectedMarkupEditor();
        if (!selected) {
            return null;
        }
        const color = resolveEditorMarkupSubtypeColor(selected.editor, selected.subtype, selected.pageIndex);
        return {
            id: getEditorIdentity(selected.editor, selected.pageIndex),
            pageIndex: selected.pageIndex,
            subtype: selected.subtype,
            color,
            markerRect: resolveEditorMarkupSubtypeHintRect(selected.editor),
        };
    }

    function resolveTextMarkupVisualColor(subtype: TMarkupSubtype, color: string) {
        if (subtype !== 'Highlight') {
            return color;
        }
        const opacity = annotationSettings.value?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity;
        return toOpaqueHighlightDisplayColor(color, opacity);
    }

    function applyTextMarkupEditorColor(
        editor: IPdfjsEditor,
        pageIndex: number,
        subtype: TMarkupSubtype,
        color: string,
    ) {
        const visualColor = resolveTextMarkupVisualColor(subtype, color);
        editor.color = visualColor;
        if (subtype === 'Highlight') {
            editor.opacity = OPAQUE_HIGHLIGHT_OPACITY;
        }
        storeEditorMarkupSubtypeColor(editor, pageIndex, color);
        updateMarkupSubtypeGeometryHintColor(editor, pageIndex, color);
        refreshEditorTextMarkupColor(editor, visualColor, subtype, pageIndex);
        editor.addToAnnotationStorage?.();
        markExistingEditorAnnotationChanged(editor);
    }

    function updateSelectedTextMarkupAnnotationColor(color: string) {
        const selected = findSelectedMarkupEditor() ?? getLiveLastSelectedMarkupEditor();
        const normalizedColor = color.trim();
        if (!selected || !normalizedColor) {
            return false;
        }

        applyTextMarkupEditorColor(selected.editor, selected.pageIndex, selected.subtype, normalizedColor);
        return true;
    }

    function updateTextMarkupAnnotationColor(
        editor: IPdfjsEditor,
        pageIndex: number,
        subtype: TMarkupSubtype,
        color: string,
    ) {
        const normalizedColor = color.trim();
        if (!normalizedColor) {
            return false;
        }

        applyTextMarkupEditorColor(editor, pageIndex, subtype, normalizedColor);
        return true;
    }

    function isMaterializedPdfAnnotationId(annotationId: string | null | undefined) {
        return Boolean(parsePdfJsAnnotationRef(annotationId));
    }

    function resolveEditorMarkupSubtypeOverride(editor: IPdfjsEditor, pageIndex: number): TMarkupSubtype | null {
        if (editor.annotationElementId) {
            const normalizedAnnotationId = normalizePdfJsAnnotationId(editor.annotationElementId);
            const byAnnotationId = markupSubtypeOverrides.get(editor.annotationElementId)
                ?? (normalizedAnnotationId ? markupSubtypeOverrides.get(normalizedAnnotationId) : undefined);
            if (byAnnotationId) {
                return byAnnotationId;
            }
            if (normalizedAnnotationId && forgottenMaterializedMarkupSubtypeAnnotationIds.has(normalizedAnnotationId)) {
                return null;
            }
        }
        const byObject = editorObjectMarkupSubtypeOverrides.get(editor);
        if (byObject) {
            return byObject;
        }
        const identity = getEditorIdentity(editor, pageIndex);
        const byIdentity = editorMarkupSubtypeOverrides.get(identity);
        if (byIdentity) {
            return byIdentity;
        }
        if (isMaterializedPdfAnnotationId(editor.annotationElementId)) {
            return null;
        }
        return null;
    }

    function getMarkupSubtypeOverrides() {
        return markupSubtypeOverrides;
    }

    function forgetMarkupSubtypeOverride(annotationId: string | null | undefined) {
        const normalizedAnnotationId = normalizePdfJsAnnotationId(annotationId);
        if (!normalizedAnnotationId) {
            return;
        }
        forgottenMaterializedMarkupSubtypeAnnotationIds.add(normalizedAnnotationId);

        for (const key of Array.from(markupSubtypeOverrides.keys())) {
            if (normalizePdfJsAnnotationId(key) === normalizedAnnotationId) {
                markupSubtypeOverrides.delete(key);
            }
        }
        for (const key of Array.from(markupSubtypeColorOverrides.keys())) {
            if (normalizePdfJsAnnotationId(key) === normalizedAnnotationId) {
                markupSubtypeColorOverrides.delete(key);
            }
        }
        for (const [
            identity,
            entry,
        ] of Array.from(markupSubtypeGeometryHints.entries())) {
            if (normalizePdfJsAnnotationId(entry.hint.annotationId) === normalizedAnnotationId) {
                markupSubtypeGeometryHints.delete(identity);
            }
        }
    }

    function getMarkupSubtypeHints() {
        const hints: IMarkupSubtypeHint[] = [];
        for (const [
            identity,
            entry,
        ] of markupSubtypeGeometryHints.entries()) {
            if (!isLiveMarkupSubtypeHintEntry(identity, entry)) {
                markupSubtypeGeometryHints.delete(identity);
                continue;
            }
            hints.push({
                ...entry.hint,
                markerRect: { ...entry.hint.markerRect },
                consumed: false,
            });
        }
        return hints;
    }

    function clearOverrides() {
        markupSubtypeOverrides.clear();
        editorMarkupSubtypeOverrides.clear();
        markupSubtypeColorOverrides.clear();
        markupSubtypeGeometryHints.clear();
        forgottenMaterializedMarkupSubtypeAnnotationIds.clear();
        lastSelectedMarkupEditor = null;
        editorObjectMarkupSubtypeOverrides = new WeakMap();
        editorObjectMarkupSubtypeColorOverrides = new WeakMap();
        markupSubtypeDrawLayer.clearDrawLayerState();
    }

    return {
        pendingAnnotationTool,
        pendingAnnotationSettings,
        toolToMarkupSubtype,
        isSelectionMarkupTool,
        shouldForceTextMarkup,
        getAnnotationMode,
        resolveMarkupSubtypeColor,
        resolveHighlightColorForTool,
        resolveHighlightOpacityForTool,
        resolveHighlightFreeForTool,
        applyHighlightParamsForTool,
        captureHighlightEditorClassFromTypes,
        enforceHighlightDefaultsForNewEditor,
        applyAnnotationSettings,
        setAnnotationTool,
        updateModeWithRetry,
        getToolUpdatePromise,
        maybeAutoResetAnnotationTool,
        resolveEditorHighlightClipPathId,
        resolveEditorDrawLayerHighlight,
        findClosestHighlightDrawLayerSvg,
        clearMarkupSubtypeEditorClass,
        applyEditorMarkupSubtypePresentation,
        resolveEditorSubtypeFromPresentation,
        syncMarkupSubtypePresentationForEditors,
        setEditorMarkupSubtypeOverride,
        resolveEditorMarkupSubtypeOverride,
        resolveEditorMarkupSubtypeColor,
        rememberMarkupSubtypeColorOverride,
        getSelectedTextMarkupAnnotationProperties,
        updateSelectedTextMarkupAnnotationColor,
        updateTextMarkupAnnotationColor,
        getMarkupSubtypeOverrides,
        getMarkupSubtypeHints,
        forgetMarkupSubtypeOverride,
        markupSubtypeOverrides,
        clearOverrides,
    };
};
