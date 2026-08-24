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
import { cast } from '@tests/helpers/cast';
import { clearEditorSelectionVisuals } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/clearEditorSelectionVisuals';

function createUiManager() {
    return {
        setActiveEditor: vi.fn(),
        unselectAll: vi.fn(),
    };
}

describe('clearEditorSelectionVisuals without a document', () => {
    it('clears the pdf.js selection state instead of throwing on the active element', () => {
        expect(typeof document).toBe('undefined');
        const uiManager = createUiManager();

        expect(() => clearEditorSelectionVisuals({
            viewerContainer: ref(null),
            uiManager: cast<AnnotationEditorUIManager>(uiManager),
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
            uiManager: cast<AnnotationEditorUIManager>(uiManager),
            isUiManagerCurrent: () => false,
            editor: null,
        });

        expect(uiManager.setActiveEditor).not.toHaveBeenCalled();
        expect(uiManager.unselectAll).not.toHaveBeenCalled();
    });
});
