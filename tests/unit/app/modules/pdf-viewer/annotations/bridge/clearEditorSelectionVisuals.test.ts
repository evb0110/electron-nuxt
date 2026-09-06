// No `@vitest-environment` docblock on purpose: this file runs in the default
// node environment, where `document` and `window` do not exist. The bridge is
// imported by composables that are evaluated during SSR, so every DOM access in
// it has to be guarded rather than only the deferred ones.
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { clearEditorSelectionVisuals } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/clearEditorSelectionVisuals';

function createUiManager() {
    const fixture = {
        setActiveEditor: vi.fn(),
        unselectAll: vi.fn(),
    } satisfies Pick<AnnotationEditorUIManager, 'setActiveEditor' | 'unselectAll'>;
    // The production function accepts PDF.js's class, while this node test
    // needs only the two methods it calls and no PDF.js constructor state.
    return Object.assign(Object.create(null), fixture);
}

describe('clearEditorSelectionVisuals without a document', () => {
    it('clears the pdf.js selection state instead of throwing on the active element', () => {
        expect(typeof document).toBe('undefined');
        const uiManager = createUiManager();

        expect(() => clearEditorSelectionVisuals({
            viewerContainer: ref(null),
            uiManager,
            isUiManagerCurrent: () => true,
            editor: null,
        })).not.toThrow();

        // The pdf.js half of the cleanup needs no DOM, so it still runs.
        expect(uiManager.setActiveEditor).toHaveBeenCalledWith(null);
        expect(uiManager.unselectAll).toHaveBeenCalledOnce();
    });

    it('does nothing at all once the editor manager it was given is stale', () => {
        const uiManager = createUiManager();

        clearEditorSelectionVisuals({
            viewerContainer: ref(null),
            uiManager,
            isUiManagerCurrent: () => false,
            editor: null,
        });

        expect(uiManager.setActiveEditor).not.toHaveBeenCalled();
        expect(uiManager.unselectAll).not.toHaveBeenCalled();
    });
});
