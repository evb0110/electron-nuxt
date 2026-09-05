import type { MaybeRefOrGetter } from 'vue';
import type { IPdfSearchMatch } from '@app/types/pdfUi';
import type { createViewportAuthority } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

interface IPdfSearchHighlightHandoffOptions {
    currentSearchMatch: MaybeRefOrGetter<IPdfSearchMatch | null>;
    navigationId: MaybeRefOrGetter<number>;
    authority: Pick<ReturnType<typeof createViewportAuthority>, 'phase' | 'activeIntent'>;
    applyHighlights: (pages: number[]) => void;
}

export const usePdfSearchHighlightHandoff = (options: IPdfSearchHighlightHandoffOptions) => {
    const currentHighlightMatch = shallowRef(toValue(options.currentSearchMatch));
    let committedNavigationId = toValue(options.navigationId);

    function commit(match: IPdfSearchMatch | null) {
        const previous = currentHighlightMatch.value;
        currentHighlightMatch.value = match;
        committedNavigationId = toValue(options.navigationId);
        options.applyHighlights([...new Set([
            previous?.pageIndex,
            match?.pageIndex,
        ]
            .filter(page => page !== undefined)
            .map(page => page + 1))]);
    }

    watch(() => [
        toValue(options.currentSearchMatch),
        toValue(options.navigationId),
    ] as const, ([
        match,
        id,
    ]) => {
        // A click changes the sidebar immediately. Its painted selection stays
        // with the outgoing page until the viewport can apply the destination.
        if (!match || id === 0 || id === committedNavigationId) {
            commit(match);
        }
    });

    watch(options.authority.phase, (phase) => {
        if (phase !== 'applying') {
            return;
        }
        const match = toValue(options.currentSearchMatch);
        const request = options.authority.activeIntent.value?.navigation;
        const target = request?.target;
        if (!match || request?.source !== 'search' || !target || !('page' in target)
            || target.page !== match.pageIndex + 1) {
            return;
        }
        if (request.searchNavigationId !== undefined && request.searchNavigationId !== toValue(options.navigationId)) {
            return;
        }
        if (target.kind === 'text-anchor' && target.searchRange
            && (target.searchRange.startOffset !== match.startOffset
                || target.searchRange.endOffset !== match.endOffset
                || target.pageMatchIndex !== undefined && target.pageMatchIndex !== match.pageMatchIndex)) {
            return;
        }
        // The authority enters this phase immediately before its synchronous
        // viewport write. Both colors change in that same browser frame.
        commit(match);
    }, {flush: 'sync'});

    return {currentHighlightMatch};
};
