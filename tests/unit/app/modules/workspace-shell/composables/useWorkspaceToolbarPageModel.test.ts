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
    it('advances rapid next-page clicks optimistically while routing only the settled target', () => {
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

            expect(goToPage).not.toHaveBeenCalled();
            expect(updateCurrentPage).not.toHaveBeenCalled();
            expect(sourcePage.value).toBe(1);
            expect(model.currentPage.value).toBe(4);

            vi.advanceTimersByTime(workspaceToolbarPageNavigationCommitDelayMs - 1);
            expect(goToPage).not.toHaveBeenCalled();
            expect(updateCurrentPage).not.toHaveBeenCalled();

            vi.advanceTimersByTime(1);
            expect(goToPage).toHaveBeenCalledTimes(1);
            expect(updateCurrentPage).not.toHaveBeenCalled();
            expect(goToPage).toHaveBeenCalledWith(4);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending toolbar navigation when another authoritative page arrives first', async () => {
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

            model.currentPage.value = 2;
            model.handleGoToPage(2);
            sourcePage.value = 9;
            await nextTick();

            expect(model.currentPage.value).toBe(9);

            vi.advanceTimersByTime(workspaceToolbarPageNavigationCommitDelayMs);

            expect(goToPage).not.toHaveBeenCalled();
            expect(updateCurrentPage).not.toHaveBeenCalled();

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
