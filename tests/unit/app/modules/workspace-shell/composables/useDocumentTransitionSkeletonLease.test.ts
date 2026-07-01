import {
    describe,
    expect,
    it,
} from 'vitest';
import { useDocumentTransitionSkeletonLease } from '@app/modules/workspace-shell/composables/useDocumentTransitionSkeletonLease';

describe('useDocumentTransitionSkeletonLease', () => {
    function createHarness(options: {pendingDocumentOpen?: boolean;} = {}) {
        const pendingDocumentOpen = ref(options.pendingDocumentOpen ?? false);
        const initialDocumentVisualReady = ref(true);
        const pdfError = ref<unknown>(null);
        const djvuError = ref<unknown>(null);
        const lease = useDocumentTransitionSkeletonLease({
            djvuError,
            onInitialVisualPending: () => {
                initialDocumentVisualReady.value = false;
            },
            onInitialVisualReady: () => {
                initialDocumentVisualReady.value = true;
            },
            pendingDocumentOpen,
            pdfError,
        });

        return {
            djvuError,
            initialDocumentVisualReady,
            lease,
            pendingDocumentOpen,
            pdfError,
        };
    }

    it('covers an open transaction until the incoming viewer paints', async () => {
        const harness = createHarness();

        harness.pendingDocumentOpen.value = true;
        await nextTick();
        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(true);

        harness.lease.handleDocumentInitialVisualPending();
        await nextTick();
        expect(harness.initialDocumentVisualReady.value).toBe(false);
        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(true);
    });

    it('covers a transaction that was already pending before the lease mounted', () => {
        const harness = createHarness({ pendingDocumentOpen: true });

        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(true);
    });

    it('does not reappear after the new document paints while the host transaction is still settling', async () => {
        const harness = createHarness();

        harness.pendingDocumentOpen.value = true;
        await nextTick();
        harness.lease.handleDocumentInitialVisualPending();
        await nextTick();

        harness.lease.handleDocumentInitialVisualReady();
        await nextTick();

        expect(harness.pendingDocumentOpen.value).toBe(true);
        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(false);
    });

    it('clears the lease when the host transaction finishes or an error appears', async () => {
        const harness = createHarness();

        harness.pendingDocumentOpen.value = true;
        await nextTick();
        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(true);

        harness.pdfError.value = new Error('open failed');
        await nextTick();
        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(false);

        harness.pdfError.value = null;
        harness.pendingDocumentOpen.value = false;
        await nextTick();
        harness.pendingDocumentOpen.value = true;
        await nextTick();
        expect(harness.lease.showDocumentTransitionSkeleton.value).toBe(true);
    });
});
