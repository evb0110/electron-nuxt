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

    it('retains pending navigation without a correctness timer until explicit viewer cancellation', async () => {
        vi.useFakeTimers();
        const scope = effectScope();
        try {
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

            model.handleGoToPage(8);
            sourcePage.value = 3;
            await nextTick();

            expect(model.currentPage.value).toBe(3);
            expect(model.navigationPage.value).toBe(8);

            vi.advanceTimersByTime(60_000);
            await nextTick();

            expect(model.currentPage.value).toBe(3);
            expect(model.navigationPage.value).toBe(8);

            model.cancelPendingNavigation();
            expect(model.currentPage.value).toBe(3);
            expect(model.navigationPage.value).toBe(3);
        } finally {
            scope.stop();
            vi.useRealTimers();
        }
    });

    it('cancels a pending command when the document session ends', async () => {
        const scope = effectScope();
        const sourcePage = ref(1);
        const sessionActive = ref(true);
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            sessionActive,
            goToPage: vi.fn(),
        }));

        if (!model) {
            throw new Error('Failed to create workspace toolbar page model');
        }

        model.handleGoToPage(6);
        expect(model.navigationPage.value).toBe(6);

        sessionActive.value = false;
        expect(model.navigationPage.value).toBe(1);

        scope.stop();
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

    it('uses viewer navigation feedback only as the command cursor until presentation commits', async () => {
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
        expect(model.currentPage.value).toBe(1);
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

    it('retires a stale toolbar target when a different authoritative command supersedes it', async () => {
        const scope = effectScope();
        const sourcePage = ref(450);
        const authoritativeCommand = ref<{
            page: number;
            revision: number
        } | null>(null);
        const model = scope.run(() => useWorkspaceToolbarPageModel({
            sourcePage,
            authoritativeCommand,
            goToPage: vi.fn(),
        }));

        if (!model) throw new Error('Failed to create workspace toolbar page model');

        model.handleGoToPage(1);
        expect(model.navigationPage.value).toBe(1);

        authoritativeCommand.value = {
            page: 450,
            revision: 2,
        };
        expect(model.navigationPage.value).toBe(450);
        expect(model.currentPage.value).toBe(450);

        scope.stop();
    });
});
