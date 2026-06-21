// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { effectScope } from 'vue';
import { useFreeTextResize } from '@app/modules/pdf-viewer/runtime/annotations/useFreeTextResize';
import type { IPdfjsEditor } from '@app/types/pdfjs';

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
});
