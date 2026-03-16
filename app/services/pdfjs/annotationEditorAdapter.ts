import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    IPdfjsAnnotationEditorLayer,
    IPdfjsEditor,
    IPdfjsEditorConstructorLike,
    IPdfjsEditorLayerWithGetEditorByUid,
    IPdfjsEditorWithEditComment,
} from '@app/types/pdfjs';
import {
    getOptionalFunction,
    getOptionalNumber,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

interface IUiManagerWithGetLayer {getLayer: (pageIndex: number) => unknown;}

interface IUiManagerWithSelectComment {selectComment: (pageIndex: number, uid: string) => void;}

interface IUiManagerWithGetEditor {getEditor: (id: string) => unknown;}

interface IUiManagerWithUnselectAll {unselectAll: () => void;}

interface IUiManagerWithGetActive {getActive: () => unknown;}


export function isPdfjsEditor(value: unknown): value is IPdfjsEditor {
    if (!isRecord(value)) {
        return false;
    }

    const div = value.div;
    if (div !== undefined && !(div instanceof HTMLElement)) {
        return false;
    }

    return (
        getOptionalString(value, 'id') !== null
        || getOptionalString(value, 'uid') !== null
        || getOptionalString(value, 'annotationElementId') !== null
        || getOptionalNumber(value, 'parentPageIndex') !== null
        || getOptionalFunction(value, 'toggleComment') !== null
        || getOptionalFunction(value, 'remove') !== null
        || getOptionalFunction(value, 'delete') !== null
        || div instanceof HTMLElement
    );
}

export function asPdfjsEditor(value: unknown): IPdfjsEditor | null {
    return isPdfjsEditor(value)
        ? value
        : null;
}

export function isPdfjsEditorWithEditComment(
    editor: IPdfjsEditor | null | undefined,
): editor is IPdfjsEditorWithEditComment {
    return Boolean(
        editor
        && getOptionalFunction(editor, 'editComment') !== null,
    );
}

function hasGetLayer(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithGetLayer {
    return getOptionalFunction(uiManager, 'getLayer') !== null;
}

function getLayerFromUiManager(
    uiManager: AnnotationEditorUIManager & IUiManagerWithGetLayer,
    pageIndex: number,
): unknown {
    const getLayer = getOptionalFunction<[number], unknown>(uiManager, 'getLayer');
    return getLayer
        ? getLayer.call(uiManager, pageIndex)
        : null;
}

function hasSelectComment(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithSelectComment {
    return getOptionalFunction(uiManager, 'selectComment') !== null;
}

function hasGetEditor(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithGetEditor {
    return getOptionalFunction(uiManager, 'getEditor') !== null;
}

function hasUnselectAll(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithUnselectAll {
    return getOptionalFunction(uiManager, 'unselectAll') !== null;
}

function hasGetEditorByUid(
    layer: unknown,
): layer is IPdfjsEditorLayerWithGetEditorByUid {
    if (!isRecord(layer)) {
        return false;
    }

    return getOptionalFunction(layer, 'getEditorByUID') !== null;
}

function hasGetActive(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithGetActive {
    return getOptionalFunction(uiManager, 'getActive') !== null;
}

export function setSelectedEditor(
    uiManager: AnnotationEditorUIManager,
    editor: unknown,
) {
    if (!isPdfjsEditor(editor)) {
        return false;
    }

    const setSelected = uiManager.setSelected as (value: unknown) => void;
    setSelected(editor);
    return true;
}

export function clearSelectedEditorState(uiManager: AnnotationEditorUIManager) {
    let cleared = false;
    if (hasUnselectAll(uiManager)) {
        uiManager.unselectAll();
        cleared = true;
    }

    const setSelected = uiManager.setSelected as ((value: unknown) => void) | undefined;
    if (typeof setSelected === 'function') {
        try {
            setSelected(null);
            cleared = true;
        } catch {
            // Ignore: older PDF.js builds may reject nullable selection values.
        }
    }

    return cleared;
}

export function getEditorsOnPage(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
) {
    return Array.from(uiManager.getEditors(pageIndex))
        .map(asPdfjsEditor)
        .filter((editor): editor is IPdfjsEditor => editor !== null);
}

export function getActiveEditor(uiManager: AnnotationEditorUIManager) {
    if (!hasGetActive(uiManager)) {
        return null;
    }
    return asPdfjsEditor(uiManager.getActive());
}

export function getEditorConstructor(editor: unknown): IPdfjsEditorConstructorLike | null {
    if (!isPdfjsEditor(editor)) {
        return null;
    }
    const ctor = (editor as { constructor?: unknown }).constructor;
    if (
        (typeof ctor === 'function' || isRecord(ctor))
        && typeof (ctor as { updateDefaultParams?: unknown }).updateDefaultParams === 'function'
    ) {
        return ctor as IPdfjsEditorConstructorLike;
    }
    return null;
}

export function getEditorByUidFromLayer(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
    uid: string,
) {
    if (!hasGetLayer(uiManager)) {
        return null;
    }

    const layer = getLayerFromUiManager(uiManager, pageIndex);
    if (!hasGetEditorByUid(layer)) {
        return null;
    }

    const getEditorByUID = getOptionalFunction<[string], unknown>(layer, 'getEditorByUID');
    return asPdfjsEditor(
        getEditorByUID
            ? getEditorByUID.call(layer, uid)
            : null,
    );
}

export function selectCommentByUid(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
    uid: string,
) {
    if (!hasSelectComment(uiManager)) {
        return false;
    }

    uiManager.selectComment(pageIndex, uid);
    return true;
}

export function getEditorById(
    uiManager: AnnotationEditorUIManager,
    id: string,
) {
    if (!hasGetEditor(uiManager)) {
        return null;
    }

    return asPdfjsEditor(uiManager.getEditor(id));
}

export function unselectAllEditors(
    uiManager: AnnotationEditorUIManager | null,
) {
    if (!uiManager || !hasUnselectAll(uiManager)) {
        return false;
    }

    uiManager.unselectAll();
    return true;
}

function isAnnotationEditorLayer(value: unknown): value is IPdfjsAnnotationEditorLayer {
    if (!isRecord(value)) {
        return false;
    }
    return value.div instanceof HTMLElement
        && getOptionalFunction(value, 'createAndAddNewEditor') !== null;
}


export function getAnnotationEditorLayer(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
): IPdfjsAnnotationEditorLayer | null {
    if (!hasGetLayer(uiManager)) {
        return null;
    }
    const layer: unknown = getLayerFromUiManager(uiManager, pageIndex)
        ?? (uiManager.currentLayer as unknown);
    return isAnnotationEditorLayer(layer) ? layer : null;
}

export function getAnnotationEditorLayerDiv(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
): HTMLElement | null {
    if (!hasGetLayer(uiManager)) {
        const current: unknown = uiManager.currentLayer as unknown;
        return isRecord(current) && current.div instanceof HTMLElement ? current.div : null;
    }
    const layer: unknown = getLayerFromUiManager(uiManager, pageIndex)
        ?? (uiManager.currentLayer as unknown);
    if (isRecord(layer) && layer.div instanceof HTMLElement) {
        return layer.div;
    }
    return null;
}
