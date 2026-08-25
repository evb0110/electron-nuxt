import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDocumentWorkspacePageSessionRestore } from '@app/modules/workspace-shell/composables/useDocumentWorkspacePageSessionRestore';

describe('useDocumentWorkspacePageSessionRestore', () => {
    it('waits for a live viewer and count, clamps once, and resets an empty viewer', async () => {
        const activeViewerAdapter = ref<unknown>(null);
        const currentPage = ref(8);
        const documentViewerRef = ref<unknown>(null);
        const isLoading = ref(true);
        const totalPages = ref(0);
        const onRestore = vi.fn();
        const scope = effectScope();
        scope.run(() => useDocumentWorkspacePageSessionRestore({
            activeViewerAdapter,
            currentPage,
            documentViewerRef,
            initialPage: 8,
            isLoading,
            onRestore,
            preserveInitialPage: true,
            totalPages,
        }));

        activeViewerAdapter.value = {};
        totalPages.value = 5;
        documentViewerRef.value = {};
        await nextTick();
        expect(onRestore).toHaveBeenCalledOnce();
        expect(onRestore).toHaveBeenCalledWith(5);

        currentPage.value = 5;
        isLoading.value = true;
        activeViewerAdapter.value = null;
        await nextTick();
        expect(currentPage.value).toBe(1);
        expect(totalPages.value).toBe(0);
        expect(isLoading.value).toBe(false);
        scope.stop();
    });

    it('does not restore a stale page into a fresh document open', async () => {
        const activeViewerAdapter = ref<unknown>({});
        const currentPage = ref(1);
        const documentViewerRef = ref<unknown>({});
        const isLoading = ref(false);
        const totalPages = ref(882);
        const onRestore = vi.fn();
        const scope = effectScope();
        scope.run(() => useDocumentWorkspacePageSessionRestore({
            activeViewerAdapter,
            currentPage,
            documentViewerRef,
            initialPage: 64,
            isLoading,
            onRestore,
            preserveInitialPage: false,
            totalPages,
        }));

        await nextTick();

        expect(onRestore).not.toHaveBeenCalled();
        expect(currentPage.value).toBe(1);
        scope.stop();
    });
});
