// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { effectScope } from 'vue';
import { useFreeTextResize } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useFreeTextResize';
import { pdfLayerVisualSnapshotClass } from '@app/modules/pdf-viewer/engine/pdf-layer-visual-snapshot/pdfLayerVisualSnapshotClass';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { cast } from '@tests/helpers/cast';

function createFreeTextEditor() {
    const div = document.createElement('div');
    div.className = 'freeTextEditor';
    const internal = document.createElement('div');
    internal.className = 'internal';
    internal.style.fontSize = '10px';
    div.append(internal);
    document.body.append(div);
    const updateParams = vi.fn();

    return {
        div,
        editor: {
            div,
            height: 1,
            serialize: () => ({
                annotationType: 'freetext',
                fontSize: 10,
            }),
            updateParams,
            width: 1,
        } as IPdfjsEditor,
        updateParams,
    };
}

describe('useFreeTextResize', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        document.documentElement.className = '';
        document.body.replaceChildren();
    });

    it('cancels pending resize font sync RAFs when its scope is disposed', () => {
        const rafCallbackRef: { current: FrameRequestCallback | null } = { current: null };
        const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            rafCallbackRef.current = callback;
            return 42;
        });
        const cancelAnimationFrame = vi.fn();
        vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
        vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);
        const emitAnnotationSetting = vi.fn();
        const emitAnnotationModified = vi.fn();
        const scope = effectScope();
        const {
            editor,
            updateParams,
        } = createFreeTextEditor();

        scope.run(() => {
            const resize = useFreeTextResize({
                getAnnotationUiManager: () => ({}) as never,
                getNumPages: () => 1,
                emitAnnotationModified,
                emitAnnotationSetting,
                scheduleAnnotationCommentsSync: vi.fn(),
            });
            resize.ensureFreeTextEditorCanResize(editor);
        });

        editor.width = 2;
        editor._onResized?.();
        expect(requestAnimationFrame).toHaveBeenCalledOnce();

        scope.stop();
        rafCallbackRef.current?.(0);

        expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
        expect(updateParams).not.toHaveBeenCalled();
        expect(emitAnnotationModified).not.toHaveBeenCalled();
        expect(emitAnnotationSetting).not.toHaveBeenCalled();
    });

    it('removes the active resize cursor class when its scope is disposed', () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn());
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const scope = effectScope();
        const {
            div,
            editor,
        } = createFreeTextEditor();
        const resizer = document.createElement('div');
        resizer.className = 'resizer bottomRight';
        div.append(resizer);

        scope.run(() => {
            const resize = useFreeTextResize({
                getAnnotationUiManager: () => ({}) as never,
                getNumPages: () => 1,
                emitAnnotationModified: vi.fn(),
                emitAnnotationSetting: vi.fn(),
                scheduleAnnotationCommentsSync: vi.fn(),
            });
            resize.ensureFreeTextEditorCanResize(editor);
        });

        resizer.dispatchEvent(new PointerEvent('pointerdown'));
        expect(document.documentElement.classList.contains('pdf-resizing-nwse')).toBe(true);

        scope.stop();

        expect(document.documentElement.classList.contains('pdf-resizing-nwse')).toBe(false);
    });

    it('preserves FreeText pixels before Escape closes the live editor layer', () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const scope = effectScope();
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page_container';
        const annotationLayer = document.createElement('div');
        annotationLayer.className = 'annotationLayer';
        const editorLayer = document.createElement('div');
        editorLayer.className = 'annotationEditorLayer';
        pageContainer.append(annotationLayer, editorLayer);
        document.body.append(pageContainer);
        const {
            div,
            editor,
        } = createFreeTextEditor();
        editorLayer.append(div);
        const persistedEditor = document.createElement('div');
        persistedEditor.className = 'freeTextEditor';
        persistedEditor.textContent = 'persisted';
        editorLayer.prepend(persistedEditor);
        div.tabIndex = 0;
        div.focus();

        scope.run(() => {
            const resize = useFreeTextResize({
                getAnnotationUiManager: () => ({}) as never,
                getNumPages: () => 1,
                emitAnnotationModified: vi.fn(),
                emitAnnotationSetting: vi.fn(),
                scheduleAnnotationCommentsSync: vi.fn(),
            });
            resize.ensureFreeTextEditorCanResize(editor);
        });
        window.addEventListener('keydown', () => editorLayer.replaceChildren(), {once: true});

        window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

        const snapshot = pageContainer.querySelector<HTMLElement>(`.${pdfLayerVisualSnapshotClass}`);
        expect(snapshot?.querySelectorAll('.freeTextEditor')).toHaveLength(2);

        scope.stop();
        expect(pageContainer.querySelector(`.${pdfLayerVisualSnapshotClass}`)).toBeNull();
    });

    it('leaves Escape untouched while the user is committing FreeText input', () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const scope = effectScope();
        const pageContainer = document.createElement('div');
        pageContainer.className = 'page_container';
        const editorLayer = document.createElement('div');
        editorLayer.className = 'annotationEditorLayer';
        pageContainer.append(editorLayer);
        document.body.append(pageContainer);
        const {
            div,
            editor,
        } = createFreeTextEditor();
        editorLayer.append(div);
        const internal = div.querySelector<HTMLElement>('.internal');
        internal!.contentEditable = 'true';
        internal!.tabIndex = 0;
        internal!.focus();

        scope.run(() => {
            const resize = useFreeTextResize({
                getAnnotationUiManager: () => ({}) as never,
                getNumPages: () => 1,
                emitAnnotationModified: vi.fn(),
                emitAnnotationSetting: vi.fn(),
                scheduleAnnotationCommentsSync: vi.fn(),
            });
            resize.ensureFreeTextEditorCanResize(editor);
        });

        window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

        expect(pageContainer.querySelector(`.${pdfLayerVisualSnapshotClass}`)).toBeNull();
        scope.stop();
    });

    it('installs pre-select after an editor receives its DOM later', () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn());
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const scope = effectScope();
        const selectedEditor = {current: null as IPdfjsEditor | null};
        const setSelected = (editor: IPdfjsEditor) => {
            selectedEditor.current = editor;
        };
        const uiManager = {setSelected};
        const editor = cast<IPdfjsEditor>({
            div: null,
            height: 1,
            isSelected: false,
            isDraggable: true,
            serialize: () => ({
                annotationType: 'freetext',
                fontSize: 10,
            }),
            width: 1,
        });
        const resize = scope.run(() => useFreeTextResize({
            getAnnotationUiManager: () => uiManager as never,
            getNumPages: () => 1,
            emitAnnotationModified: vi.fn(),
            emitAnnotationSetting: vi.fn(),
            scheduleAnnotationCommentsSync: vi.fn(),
        }));
        if (!resize) {
            throw new Error('Expected FreeText resize scope');
        }

        resize.ensureFreeTextEditorCanResize(editor);
        const div = document.createElement('div');
        div.className = 'freeTextEditor';
        document.body.append(div);
        editor.div = div;
        resize.ensureFreeTextEditorCanResize(editor);
        div.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));

        expect(selectedEditor.current).toBe(editor);
        scope.stop();
    });

    it('records resize geometry and re-resolves the editor for undo after reload', () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const scope = effectScope();
        const {editor: staleEditor} = createFreeTextEditor();
        staleEditor.id = 'free-text-1';
        staleEditor.x = 0.1;
        staleEditor.y = 0.2;
        const {editor: rebuiltEditor} = createFreeTextEditor();
        rebuiltEditor.id = 'free-text-1';
        rebuiltEditor.x = 0.6;
        rebuiltEditor.y = 0.7;
        rebuiltEditor.width = 3;
        rebuiltEditor.height = 4;
        const registerHistoryCommand = vi.fn();
        const manager = {getEditors: vi.fn(() => [rebuiltEditor])};
        const resize = scope.run(() => useFreeTextResize({
            getAnnotationUiManager: () => manager as never,
            getNumPages: () => 1,
            emitAnnotationModified: vi.fn(),
            emitAnnotationSetting: vi.fn(),
            scheduleAnnotationCommentsSync: vi.fn(),
            registerHistoryCommand,
        }));
        if (!resize) throw new Error('Expected FreeText resize scope');
        resize.ensureFreeTextEditorCanResize(staleEditor);

        staleEditor._onResizing?.();
        staleEditor.width = 2;
        staleEditor.height = 2;
        staleEditor._onResized?.();

        const command = registerHistoryCommand.mock.calls[0]?.[0];
        expect(command).toBeDefined();
        command.undo();
        expect(rebuiltEditor).toMatchObject({
            x: 0.1,
            y: 0.2,
            width: 1,
            height: 1,
        });
        expect(staleEditor.width).toBe(2);
        scope.stop();
    });

    it('resolves a reloaded editor on its known page without scanning the document', () => {
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const scope = effectScope();
        const {editor: staleEditor} = createFreeTextEditor();
        staleEditor.id = 'free-text-large-document';
        staleEditor.parentPageIndex = 2_645;
        staleEditor.x = 0.1;
        staleEditor.y = 0.2;
        const {editor: rebuiltEditor} = createFreeTextEditor();
        rebuiltEditor.id = 'free-text-large-document';
        rebuiltEditor.parentPageIndex = 2_645;
        rebuiltEditor.x = 0.6;
        rebuiltEditor.y = 0.7;
        rebuiltEditor.width = 3;
        rebuiltEditor.height = 4;
        const getEditors = vi.fn((pageIndex: number) => {
            if (pageIndex !== 2_645) {
                throw new Error(`Unexpected document-wide editor scan for page ${pageIndex}`);
            }
            return [rebuiltEditor];
        });
        const registerHistoryCommand = vi.fn();
        const resize = scope.run(() => useFreeTextResize({
            getAnnotationUiManager: () => ({getEditors}) as never,
            getNumPages: () => 2_646,
            emitAnnotationModified: vi.fn(),
            emitAnnotationSetting: vi.fn(),
            scheduleAnnotationCommentsSync: vi.fn(),
            registerHistoryCommand,
        }));
        if (!resize) throw new Error('Expected FreeText resize scope');
        resize.ensureFreeTextEditorCanResize(staleEditor);

        staleEditor._onResizing?.();
        staleEditor.width = 2;
        staleEditor.height = 2;
        staleEditor._onResized?.();

        const command = registerHistoryCommand.mock.calls[0]?.[0];
        expect(command).toBeDefined();
        command.undo();

        expect(getEditors).toHaveBeenCalledOnce();
        expect(rebuiltEditor).toMatchObject({
            x: 0.1,
            y: 0.2,
            width: 1,
            height: 1,
        });
        scope.stop();
    });
});
