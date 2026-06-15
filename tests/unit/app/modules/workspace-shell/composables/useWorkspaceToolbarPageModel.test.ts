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
import { WORKSPACE_PAGE_NAVIGATION_LOCK_MS } from '@app/modules/workspace-shell/workspacePageNavigationLockMs';

describe('useWorkspaceToolbarPageModel', () => {
    it('advances rapid next-page clicks through command state while displaying the authoritative source', async () => {
        const scope = effectScope();
        const sourcePage = ref(1);
        const goToPage = vi.fn();

        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            goToPage,
        }));

        if (!model) {
            throw new Error('Failed to create workspace toolbar page model');
        }

        for (let i = 0; i < 3; i += 1) {
            const nextPage = stepBySpread(model.navigationPage.value, 'single', 10, 1);
            model.handleGoToPage(nextPage);
        }

        expect(sourcePage.value).toBe(1);
        expect(model.currentPage.value).toBe(1);
        expect(model.navigationPage.value).toBe(4);
        expect(goToPage).toHaveBeenCalledTimes(3);
        expect(goToPage).toHaveBeenNthCalledWith(1, 2);
        expect(goToPage).toHaveBeenNthCalledWith(2, 3);
        expect(goToPage).toHaveBeenNthCalledWith(3, 4);

        sourcePage.value = 2;
        await nextTick();
        expect(model.currentPage.value).toBe(2);
        expect(model.navigationPage.value).toBe(4);

        sourcePage.value = 4;
        await nextTick();
        expect(model.currentPage.value).toBe(4);
        expect(model.navigationPage.value).toBe(4);

        sourcePage.value = 5;
        await nextTick();
        expect(model.currentPage.value).toBe(5);
        expect(model.navigationPage.value).toBe(5);

        scope.stop();
    });

    it('keeps the pending command target while displaying intermediate source pages', async () => {
        const scope = effectScope();
        const sourcePage = ref(1);
        const goToPage = vi.fn();

        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            goToPage,
        }));

        if (!model) {
            throw new Error('Failed to create workspace toolbar page model');
        }

        model.handleGoToPage(2);
        sourcePage.value = 9;
        await nextTick();

        expect(model.currentPage.value).toBe(9);
        expect(model.navigationPage.value).toBe(2);
        expect(goToPage).toHaveBeenCalledTimes(1);
        expect(goToPage).toHaveBeenCalledWith(2);

        sourcePage.value = 2;
        await nextTick();
        expect(model.currentPage.value).toBe(2);
        expect(model.navigationPage.value).toBe(2);

        scope.stop();
    });

    it('reconciles to the authoritative source page if the pending target never catches up', async () => {
        vi.useFakeTimers();
        const scope = effectScope();
        try {
            const sourcePage = ref(1);
            const goToPage = vi.fn();

            const model = scope.run(() => useWorkspaceToolbarPageModel({
                sourcePage,
                goToPage,
            }));

            if (!model) {
                throw new Error('Failed to create workspace toolbar page model');
            }

            model.handleGoToPage(8);
            sourcePage.value = 3;
            await nextTick();

            expect(model.currentPage.value).toBe(3);
            expect(model.navigationPage.value).toBe(8);

            vi.advanceTimersByTime(WORKSPACE_PAGE_NAVIGATION_LOCK_MS);
            await nextTick();

            expect(model.currentPage.value).toBe(3);
            expect(model.navigationPage.value).toBe(3);

            sourcePage.value = 4;
            await nextTick();
            expect(model.currentPage.value).toBe(4);
            expect(model.navigationPage.value).toBe(4);
        } finally {
            scope.stop();
            vi.useRealTimers();
        }
    });

    it('syncs back to the authoritative snapshot page', async () => {
        const scope = effectScope();
        const sourcePage = ref(5);
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            goToPage: vi.fn(),
        }));

        if (!model) {
            throw new Error('Failed to create workspace toolbar page model');
        }

        sourcePage.value = 6;
        await nextTick();

        expect(model.currentPage.value).toBe(6);
        expect(model.navigationPage.value).toBe(6);

        scope.stop();
    });

    it('uses viewer navigation feedback for display without replacing the committed source page', async () => {
        const scope = effectScope();
        const sourcePage = ref(1);
        const feedbackPage = ref<number | null>(null);
        const goToPage = vi.fn();

        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            feedbackPage,
            goToPage,
        }));

        if (!model) {
            throw new Error('Failed to create workspace toolbar page model');
        }

        model.handleGoToPage(4);
        expect(sourcePage.value).toBe(1);
        expect(model.currentPage.value).toBe(1);
        expect(model.navigationPage.value).toBe(4);

        feedbackPage.value = 4;
        await nextTick();
        expect(sourcePage.value).toBe(1);
        expect(model.currentPage.value).toBe(4);
        expect(model.navigationPage.value).toBe(4);

        feedbackPage.value = null;
        await nextTick();
        expect(model.currentPage.value).toBe(1);
        expect(model.navigationPage.value).toBe(4);

        sourcePage.value = 4;
        await nextTick();
        expect(model.currentPage.value).toBe(4);
        expect(model.navigationPage.value).toBe(4);

        scope.stop();
    });
});
