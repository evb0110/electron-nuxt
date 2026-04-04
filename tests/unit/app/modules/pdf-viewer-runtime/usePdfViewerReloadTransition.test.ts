import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerReloadTransition } from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerReloadTransition';

describe('usePdfViewerReloadTransition', () => {
    it('defers effective zoom updates until the visual reload transition ends', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });

        transition.emitEffectiveZoom(1.94);
        expect(emitEffectiveZoom).toHaveBeenCalledWith(1.94);

        const token = transition.beginVisualReloadTransition('reload-recovery');
        transition.emitEffectiveZoom(1);
        transition.emitEffectiveZoom(1.94);

        expect(emitEffectiveZoom).toHaveBeenCalledTimes(1);
        expect(transition.isVisualReloadTransitionActive.value).toBe(true);

        transition.endVisualReloadTransition(token, 'warm-render-complete');

        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
        expect(emitEffectiveZoom).toHaveBeenCalledTimes(2);
        expect(emitEffectiveZoom).toHaveBeenLastCalledWith(1.94);
    });

    it('ignores stale transition tokens when ending the visual reload transition', () => {
        const emitEffectiveZoom = vi.fn();
        const transition = usePdfViewerReloadTransition({ emitEffectiveZoom });

        transition.beginVisualReloadTransition('first');
        const activeToken = transition.beginVisualReloadTransition('second');
        transition.emitEffectiveZoom(1.5);
        transition.endVisualReloadTransition(activeToken - 1, 'stale');

        expect(transition.isVisualReloadTransitionActive.value).toBe(true);
        expect(emitEffectiveZoom).not.toHaveBeenCalled();

        transition.endVisualReloadTransition(activeToken, 'complete');

        expect(transition.isVisualReloadTransitionActive.value).toBe(false);
        expect(emitEffectiveZoom).toHaveBeenCalledWith(1.5);
    });
});
