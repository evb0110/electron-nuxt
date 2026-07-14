import { createDocumentPageSourceSearchBackend } from '@app/utils/document-viewer/search/createDocumentPageSourceSearchBackend';
import type { IDocumentPageSource } from '@app/utils/document-viewer/source/documentPageSource';
import { useDocumentSearchSession } from '@app/modules/workspace-shell/composables/useDocumentSearchSession';

interface IUseDocumentSourceSidebarSessionOptions {onNavigate: (pageIndex: number) => void;}

/**
 * Owns the shared sidebar state published by non-PDF document adapters.
 * Keeping this at workspace scope means sidebar lifetime, search navigation,
 * and annotation invalidation do not depend on a format viewer being remounted.
 */
export const useDocumentSourceSidebarSession = (options: IUseDocumentSourceSidebarSessionOptions) => {
    const source = shallowRef<IDocumentPageSource | null>(null);
    const backend = computed(() => createDocumentPageSourceSearchBackend(source.value));
    const searchSession = useDocumentSearchSession({
        backend,
        onNavigate: match => options.onNavigate(match.pageIndex),
    });

    function publishSource(nextSource: IDocumentPageSource | null) {
        source.value = nextSource;
    }

    return {
        publishSource,
        searchSession,
        source,
    };
};
