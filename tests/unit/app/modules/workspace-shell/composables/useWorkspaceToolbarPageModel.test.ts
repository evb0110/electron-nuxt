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
    it('advances rapid next-page clicks optimistically while routing each target immediately', async () => {
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
            const nextPage = stepBySpread(model.currentPage.value, 'single', 10, 1);
            model.currentPage.value = nextPage;
            model.handleGoToPage(nextPage);
        }

        expect(sourcePage.value).toBe(1);
        expect(model.currentPage.value).toBe(4);
        expect(goToPage).toHaveBeenCalledTimes(3);
        expect(goToPage).toHaveBeenNthCalledWith(1, 2);
        expect(goToPage).toHaveBeenNthCalledWith(2, 3);
        expect(goToPage).toHaveBeenNthCalledWith(3, 4);

        sourcePage.value = 2;
        await nextTick();
        expect(model.currentPage.value).toBe(4);

        sourcePage.value = 4;
        await nextTick();
        expect(model.currentPage.value).toBe(4);

        sourcePage.value = 5;
        await nextTick();
        expect(model.currentPage.value).toBe(5);

        scope.stop();
    });

    it('ignores intermediate source pages until the pending target catches up', async () => {
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

        model.currentPage.value = 2;
        model.handleGoToPage(2);
        sourcePage.value = 9;
        await nextTick();

        expect(model.currentPage.value).toBe(2);
        expect(goToPage).toHaveBeenCalledTimes(1);
        expect(goToPage).toHaveBeenCalledWith(2);

        sourcePage.value = 2;
        await nextTick();
        expect(model.currentPage.value).toBe(2);

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

            model.currentPage.value = 8;
            model.handleGoToPage(8);
            sourcePage.value = 3;
            await nextTick();

            expect(model.currentPage.value).toBe(8);

            vi.advanceTimersByTime(WORKSPACE_PAGE_NAVIGATION_LOCK_MS);
            await nextTick();

            expect(model.currentPage.value).toBe(3);

            sourcePage.value = 4;
            await nextTick();
            expect(model.currentPage.value).toBe(4);
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

        model.currentPage.value = 7;
        sourcePage.value = 6;
        await nextTick();

        expect(model.currentPage.value).toBe(6);

        scope.stop();
    });
});
