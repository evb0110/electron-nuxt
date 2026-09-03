import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {createWorkspacePdfSearchResultNavigation} from '@app/modules/workspace-shell/composables/createWorkspacePdfSearchResultNavigation';

describe('createWorkspacePdfSearchResultNavigation', () => {
    it('lets the viewer search navigation own the single exact-match scroll', () => {
        const calls: string[] = [];
        const select = vi.fn(() => calls.push('select'));
        const activate = createWorkspacePdfSearchResultNavigation({
            results: ref([{pageIndex: 2}]),
            select,
        });

        activate(0);

        expect(select).toHaveBeenCalledWith(0);
        expect(calls).toEqual(['select']);
    });

    it('ignores a stale result index', () => {
        const select = vi.fn();
        const activate = createWorkspacePdfSearchResultNavigation({
            results: ref([{pageIndex: 2}]),
            select,
        });

        activate(1);

        expect(select).not.toHaveBeenCalled();
    });
});
