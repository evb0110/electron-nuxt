import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { usePdfViewerDelayedSkeleton } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerDelayedSkeleton';

function createHarness() {
    const scope = effectScope();
    const pendingPages = ref(new Set<number>());
    const trackedPages = ref([1]);
    const blockSkeletons = ref(false);
    const skeleton = scope.run(() => usePdfViewerDelayedSkeleton({
        delayMs: 140,
        trackedPages,
        blockSkeletons,
        shouldShowSkeletonNow: pageNumber => pendingPages.value.has(pageNumber),
    }));
    if (!skeleton) {
        throw new Error('Failed to create delayed skeleton harness');
    }

    return {
        blockSkeletons,
        pendingPages,
        scope,
        skeleton,
        trackedPages,
    };
}

function createImmediateHarness() {
    const scope = effectScope();
    const pendingPages = ref(new Set<number>());
    const skeleton = scope.run(() => usePdfViewerDelayedSkeleton({
        delayMs: 0,
        trackedPages: ref([1]),
        blockSkeletons: ref(false),
        shouldShowSkeletonNow: pageNumber => pendingPages.value.has(pageNumber),
    }));
    if (!skeleton) {
        throw new Error('Failed to create immediate skeleton harness');
    }

    return {
        pendingPages,
        scope,
        skeleton,
    };
}

describe('usePdfViewerDelayedSkeleton', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('waits before showing a pending page skeleton', async () => {
        vi.useFakeTimers();
        const {
            pendingPages,
            scope,
            skeleton,
        } = createHarness();
        pendingPages.value = new Set([1]);

        expect(skeleton.shouldShowSkeleton(1)).toBe(false);
        await vi.advanceTimersByTimeAsync(139);
        expect(skeleton.shouldShowSkeleton(1)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(skeleton.shouldShowSkeleton(1)).toBe(true);

        scope.stop();
    });

    it('shows pending page skeletons immediately when delay is disabled', () => {
        const {
            pendingPages,
            scope,
            skeleton,
        } = createImmediateHarness();
        pendingPages.value = new Set([1]);

        expect(skeleton.shouldShowSkeleton(1)).toBe(true);

        scope.stop();
    });

    it('cancels the delayed skeleton when the page renders quickly', async () => {
        vi.useFakeTimers();
        const {
            pendingPages,
            scope,
            skeleton,
        } = createHarness();
        pendingPages.value = new Set([1]);

        expect(skeleton.shouldShowSkeleton(1)).toBe(false);
        skeleton.markPageRendered(1);
        pendingPages.value = new Set();

        await vi.advanceTimersByTimeAsync(200);

        expect(skeleton.shouldShowSkeleton(1)).toBe(false);

        scope.stop();
    });

    it('clears delayed skeletons while the loading overlay is blocking page skeletons', async () => {
        vi.useFakeTimers();
        const {
            blockSkeletons,
            pendingPages,
            scope,
            skeleton,
        } = createHarness();
        pendingPages.value = new Set([1]);

        expect(skeleton.shouldShowSkeleton(1)).toBe(false);
        blockSkeletons.value = true;
        await nextTick();
        await vi.advanceTimersByTimeAsync(200);

        expect(skeleton.shouldShowSkeleton(1)).toBe(false);

        scope.stop();
    });
});
