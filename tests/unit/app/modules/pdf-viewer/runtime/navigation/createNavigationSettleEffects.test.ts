import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { nextTick } from 'vue';
import { createNavigationSettleEffects } from '@app/modules/pdf-viewer/runtime/navigation/createNavigationSettleEffects';

describe('createNavigationSettleEffects', () => {
    it('reapplies mutation-driven continuous navigation layout synchronously', () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });
        const markerRect = {
            left: 0.11,
            top: 0.22,
            width: 0.33,
            height: 0.44,
        };

        effects.scheduleLayoutReapply(7, 165, 'mutation', { markerRect });

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 165,
            reason: 'mutation',
            runId: 7,
            scrollOptions: { markerRect },
        });
    });

    it('reapplies resize-driven continuous navigation layout synchronously', () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });

        effects.scheduleLayoutReapply(3, 97, 'resize');

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 97,
            reason: 'resize',
            runId: 3,
            scrollOptions: undefined,
        });
    });

    it('coalesces scroll-driven continuous navigation layout reapply until next tick', async () => {
        const onLayoutReapply = vi.fn();
        const effects = createNavigationSettleEffects({
            getLayoutObserverElements: () => [],
            hasLayoutMutation: () => false,
            onLayoutReapply,
        });

        effects.scheduleLayoutReapply(3, 97, 'scroll');
        effects.scheduleLayoutReapply(3, 97, 'scroll');

        expect(onLayoutReapply).not.toHaveBeenCalled();

        await nextTick();

        expect(onLayoutReapply).toHaveBeenCalledExactlyOnceWith({
            pageNumber: 97,
            reason: 'scroll',
            runId: 3,
            scrollOptions: undefined,
        });
    });
});
