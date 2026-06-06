import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { stepBySpread } from '@app/utils/pdfViewMode';
import { useWorkspaceToolbarPageModel } from '@app/modules/workspace-shell/composables/useWorkspaceToolbarPageModel';
import { workspaceToolbarPageNavigationCommitDelayMs } from '@app/modules/workspace-shell/toolbar/workspaceToolbarPageNavigationCommitDelayMs';

describe('useWorkspaceToolbarPageModel', () => {
    it('advances rapid next-page clicks optimistically while coalescing viewer navigation', () => {
        vi.useFakeTimers();
        try {
            const scope = effectScope();
            const sourcePage = ref(1);
            const updateCurrentPage = vi.fn();
            const goToPage = vi.fn();

            const model = scope.run(() => useWorkspaceToolbarPageModel({
                sourcePage,
                updateCurrentPage,
                goToPage,
            }));

            if (!model) {
                throw new Error('Failed to create workspace toolbar page model');
            }

            for (let i = 0; i < 3; i += 1) {
                const nextPage = stepBySpread(model.currentPage.value, 'single', 10, 1);
                model.currentPage.value = nextPage;
                model.handleGoToPage(nextPage);
            }

            expect(goToPage).toHaveBeenNthCalledWith(1, 2);
            expect(updateCurrentPage).toHaveBeenNthCalledWith(1, 2);
            expect(goToPage).toHaveBeenCalledTimes(1);
            expect(updateCurrentPage).toHaveBeenCalledTimes(1);
            expect(sourcePage.value).toBe(1);
            expect(model.currentPage.value).toBe(4);

            vi.advanceTimersByTime(workspaceToolbarPageNavigationCommitDelayMs - 1);
            expect(goToPage).toHaveBeenCalledTimes(1);
            expect(updateCurrentPage).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(1);
            expect(goToPage).toHaveBeenNthCalledWith(2, 4);
            expect(updateCurrentPage).toHaveBeenNthCalledWith(2, 4);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('syncs back to the authoritative snapshot page', async () => {
        const scope = effectScope();
        const sourcePage = ref(5);
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            updateCurrentPage: vi.fn(),
            goToPage: vi.fn(),
        }));

        if (!model) {
            throw new Error('Failed to create workspace toolbar page model');
        }

        model.currentPage.value = 7;
        sourcePage.value = 6;
        await nextTick();

        expect(model.currentPage.value).toBe(6);

        scope.stop();
    });
});
