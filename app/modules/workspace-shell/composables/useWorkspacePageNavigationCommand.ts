import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/public';

/** Publishes every workspace navigation command so toolbar-local intent cannot outlive a newer source. */
export const useWorkspacePageNavigationCommand = (
    commit: (page: number, options?: IScrollToPageOptions) => void,
) => {
    const navigationCommand = shallowRef<{
        page: number;
        revision: number
    } | null>(null);

    function handleGoToPage(page: number, options?: IScrollToPageOptions) {
        navigationCommand.value = {
            page,
            revision: (navigationCommand.value?.revision ?? 0) + 1,
        };
        commit(page, options);
    }

    return {
        handleGoToPage,
        navigationCommand,
    };
};
