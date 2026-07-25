import {
    effectScope,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useAnnotationMutationVisualEffects } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationVisualEffects';
import type {
    IAnnotationMutationVisualEffect,
    IAnnotationMutationVisualEffectsState,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/removeAnnotationCommentDom', () => ({removeAnnotationCommentDom: vi.fn()}));

function createVisualEffectsState(): IAnnotationMutationVisualEffectsState {
    const version = ref(0);
    const effects = ref<readonly IAnnotationMutationVisualEffect[]>([]);
    return {
        version,
        effects,
        enqueue: (effect) => {
            effects.value = [{
                ...effect,
                id: 1,
            }];
            version.value += 1;
        },
        consumeThrough: (id) => {
            effects.value = effects.value.filter(effect => effect.id > id);
            version.value += 1;
        },
    };
}

describe('useAnnotationMutationVisualEffects lifecycle', () => {
    it('does not consume queued effects after its scope is disposed during rendering', async () => {
        const state = createVisualEffectsState();
        const render = Promise.withResolvers<undefined>();
        const renderVisiblePages = vi.fn(() => render.promise);
        const scope = effectScope();
        const runner = scope.run(() => useAnnotationMutationVisualEffects({
            viewerContainer: ref({} as HTMLElement),
            annotationCommentsCache: ref([]),
            textMarkupPresentation: {notify: vi.fn()},
            invalidatePages: vi.fn(),
            renderVisiblePages,
            visualEffects: state,
        }));
        if (!runner) {
            throw new Error('Expected annotation effect scope');
        }
        state.enqueue({
            kind: 'render-page-text-markup',
            pageNumber: 2,
        });
        const flush = runner.flushVisualEffects();
        await vi.waitFor(() => expect(renderVisiblePages).toHaveBeenCalledOnce());

        scope.stop();
        render.resolve(undefined);
        await flush;

        expect(state.effects.value).toHaveLength(1);
    });
});
