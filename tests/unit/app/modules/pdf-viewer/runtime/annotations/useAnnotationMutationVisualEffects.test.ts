import {
    computed,
    effectScope,
    ref,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { useAnnotationMutationVisualEffects } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationMutationVisualEffects';
import type {
    IAnnotationMutationVisualEffect,
    IAnnotationMutationVisualEffectsState,
} from '@app/modules/pdf-viewer/runtime/annotations/annotationMutationVisualEffects.types';

const {
    applyAnnotationCommentTextMarkupColor,
    applyAnnotationCommentTextMarkupVisualOverlay,
    removeAnnotationCommentDom,
} = vi.hoisted(() => ({
    applyAnnotationCommentTextMarkupColor: vi.fn(() => true),
    applyAnnotationCommentTextMarkupVisualOverlay: vi.fn(() => true),
    removeAnnotationCommentDom: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupColor', () => ({applyAnnotationCommentTextMarkupColor}));
vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/applyAnnotationCommentTextMarkupVisualOverlay', () => ({applyAnnotationCommentTextMarkupVisualOverlay}));
vi.mock('@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/removeAnnotationCommentDom', () => ({removeAnnotationCommentDom}));

function createComment(overrides: Partial<IAnnotationCommentSummary> = {}): IAnnotationCommentSummary {
    return {
        id: overrides.id ?? 'ann-1',
        stableKey: overrides.stableKey ?? 'ann:0:stable-1',
        pageIndex: overrides.pageIndex ?? 0,
        pageNumber: overrides.pageNumber ?? 1,
        text: overrides.text ?? 'Marked text',
        kindLabel: overrides.kindLabel ?? null,
        subtype: overrides.subtype ?? 'Highlight',
        author: overrides.author ?? null,
        modifiedAt: overrides.modifiedAt ?? null,
        color: overrides.color ?? '#22c55e',
        colorEdited: overrides.colorEdited,
        uid: overrides.uid ?? null,
        annotationId: overrides.annotationId ?? '12R0',
        source: overrides.source ?? 'pdf',
        markerRect: overrides.markerRect ?? {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        },
    };
}

function createVisualEffectsState(): IAnnotationMutationVisualEffectsState {
    const version = ref(0);
    const effects = ref<readonly IAnnotationMutationVisualEffect[]>([]);
    let nextId = 1;
    return {
        version,
        effects,
        enqueue: (effect) => {
            effects.value = [
                ...effects.value,
                {
                    ...effect,
                    id: nextId,
                },
            ];
            nextId += 1;
            version.value += 1;
        },
        consumeThrough: (id) => {
            effects.value = effects.value.filter(effect => effect.id > id);
            version.value += 1;
        },
    };
}

describe('useAnnotationMutationVisualEffects', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('applies highlight display color while keeping overlay color raw', async () => {
        const comment = createComment({ color: '#22c55e' });
        const state = createVisualEffectsState();
        const viewerContainer = {} as HTMLElement;
        const renderVisiblePages = vi.fn(async () => undefined);
        const runner = useAnnotationMutationVisualEffects({
            viewerContainer: ref(viewerContainer),
            annotationCommentsCache: ref([comment]),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            renderVisiblePages,
            visualEffects: state,
        });

        state.enqueue({
            kind: 'text-markup-color',
            stableKey: comment.stableKey,
            annotationId: comment.annotationId,
            pageNumber: comment.pageNumber,
            commentSnapshot: comment,
            color: '#22c55e',
            sourceColor: '#ef4444',
        });
        await runner.flushVisualEffects();

        expect(applyAnnotationCommentTextMarkupColor).toHaveBeenCalledWith(
            viewerContainer,
            comment,
            '#b2ebc7',
            {
                sourceColor: '#ef4444',
                suppressNativeTextMarkupDecoration: true,
            },
        );
        expect(applyAnnotationCommentTextMarkupVisualOverlay).toHaveBeenCalledWith(
            viewerContainer,
            comment,
            '#22c55e',
            { highlightOpacity: DEFAULT_ANNOTATION_SETTINGS.highlightOpacity },
        );
        expect(state.effects.value).toEqual([]);
    });

    it('renders the affected page for render-page effects', async () => {
        const state = createVisualEffectsState();
        const renderVisiblePages = vi.fn(async () => undefined);
        const runner = useAnnotationMutationVisualEffects({
            viewerContainer: ref({} as HTMLElement),
            annotationCommentsCache: ref([]),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            renderVisiblePages,
            visualEffects: state,
        });

        state.enqueue({
            kind: 'render-page-text-markup',
            pageNumber: 3,
        });
        await runner.flushVisualEffects();

        expect(renderVisiblePages).toHaveBeenCalledWith(
            {
                start: 3,
                end: 3,
            },
            {
                preserveRenderedPages: true,
                forceRerender: true,
                bufferOverride: 0,
            },
        );
    });

    it('removes annotation DOM from the comment snapshot after cache deletion', async () => {
        const comment = createComment({
            stableKey: 'ann:0:removed-stable',
            annotationId: '19R0',
        });
        const state = createVisualEffectsState();
        const viewerContainer = {} as HTMLElement;
        const runner = useAnnotationMutationVisualEffects({
            viewerContainer: ref(viewerContainer),
            annotationCommentsCache: ref([]),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
            renderVisiblePages: vi.fn(async () => undefined),
            visualEffects: state,
        });

        state.enqueue({
            kind: 'annotation-dom-removal',
            stableKey: comment.stableKey,
            annotationId: comment.annotationId,
            pageNumber: comment.pageNumber,
            commentSnapshot: comment,
        });
        await runner.flushVisualEffects();

        expect(removeAnnotationCommentDom).toHaveBeenCalledWith(viewerContainer, comment);
    });

    it('does not consume queued effects after its scope is disposed during rendering', async () => {
        const state = createVisualEffectsState();
        const render = Promise.withResolvers<undefined>();
        const renderVisiblePages = vi.fn(() => render.promise);
        const scope = effectScope();
        const runner = scope.run(() => useAnnotationMutationVisualEffects({
            viewerContainer: ref({} as HTMLElement),
            annotationCommentsCache: ref([]),
            annotationSettings: computed(() => DEFAULT_ANNOTATION_SETTINGS),
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
        expect(removeAnnotationCommentDom).not.toHaveBeenCalled();
    });
});
