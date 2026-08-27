// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    shallowRef,
} from 'vue';
import { usePdfAnnotationEditorLifecycle } from '@app/modules/pdf-viewer/runtime/sessions/usePdfAnnotationEditorLifecycle';

function createHarness(initial: {
    document?: object | null;
    container?: HTMLElement | null;
} = {}) {
    const pdfDocument = shallowRef(initial.document ?? null);
    const viewerContainer = shallowRef(initial.container ?? null);
    const initialize = vi.fn();
    const destroy = vi.fn();
    const scope = effectScope();
    scope.run(() => usePdfAnnotationEditorLifecycle({
        pdfDocument,
        viewerContainer,
        initialize,
        destroy,
    }));
    return {
        destroy,
        initialize,
        pdfDocument,
        stop: () => scope.stop(),
        viewerContainer,
    };
}

describe('PDF annotation editor lifecycle', () => {
    it('initializes when a restored document arrives before its viewer element', () => {
        const documentProxy = {};
        const harness = createHarness({document: documentProxy});

        expect(harness.initialize).not.toHaveBeenCalled();

        harness.viewerContainer.value = document.createElement('div');

        expect(harness.initialize).toHaveBeenCalledOnce();
        expect(harness.destroy).not.toHaveBeenCalled();
        harness.stop();
    });

    it('initializes immediately when both owners already exist', () => {
        const harness = createHarness({
            document: {},
            container: document.createElement('div'),
        });

        expect(harness.initialize).toHaveBeenCalledOnce();
        harness.stop();
    });

    it('destroys and reinitializes when either owner changes', () => {
        const firstContainer = document.createElement('div');
        const harness = createHarness({
            document: {},
            container: firstContainer,
        });

        harness.viewerContainer.value = null;
        expect(harness.destroy).toHaveBeenCalledOnce();

        harness.viewerContainer.value = document.createElement('div');
        expect(harness.initialize).toHaveBeenCalledTimes(2);

        harness.pdfDocument.value = {};
        expect(harness.initialize).toHaveBeenCalledTimes(3);
        harness.stop();
    });
});
