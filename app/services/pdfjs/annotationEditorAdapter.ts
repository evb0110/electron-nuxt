import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    getOptionalFunction,
    getOptionalNumber,
    getOptionalString,
    isRecord,
} from '@app/services/pdfjs/runtime';

type TUiManagerSelectedEditor = Parameters<
    AnnotationEditorUIManager['setSelected']
>[0];

interface IUiManagerWithGetLayer {getLayer: (pageIndex: number) => unknown;}

interface IUiManagerWithSelectComment {selectComment: (pageIndex: number, uid: string) => void;}

interface IUiManagerWithGetEditor {getEditor: (id: string) => unknown;}

interface IUiManagerWithUnselectAll {unselectAll: () => void;}

interface IEditorLayerWithGetEditorByUid {getEditorByUID: (uid: string) => unknown;}

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

function toPdfjsEditor(value: unknown): IPdfjsEditor | null {
    return isPdfjsEditor(value)
        ? value
        : null;
}

function hasGetLayer(
    uiManager: AnnotationEditorUIManager,
): uiManager is AnnotationEditorUIManager & IUiManagerWithGetLayer {
    return getOptionalFunction(uiManager, 'getLayer') !== null;
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
): layer is IEditorLayerWithGetEditorByUid {
    if (!isRecord(layer)) {
        return false;
    }

    return getOptionalFunction(layer, 'getEditorByUID') !== null;
}

export function setSelectedEditor(
    uiManager: AnnotationEditorUIManager,
    editor: unknown,
) {
    if (!isPdfjsEditor(editor)) {
        return false;
    }

    const setSelected = uiManager.setSelected as (value: TUiManagerSelectedEditor) => void;
    setSelected(editor as TUiManagerSelectedEditor);
    return true;
}

export function getEditorByUidFromLayer(
    uiManager: AnnotationEditorUIManager,
    pageIndex: number,
    uid: string,
) {
    if (!hasGetLayer(uiManager)) {
        return null;
    }

    const layer = uiManager.getLayer(pageIndex);
    if (!hasGetEditorByUid(layer)) {
        return null;
    }

    return toPdfjsEditor(layer.getEditorByUID(uid));
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

    return toPdfjsEditor(uiManager.getEditor(id));
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
