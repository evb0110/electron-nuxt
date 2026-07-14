import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {createWorkspacePdfSearchResultNavigation} from '@app/modules/workspace-shell/composables/createWorkspacePdfSearchResultNavigation';

describe('createWorkspacePdfSearchResultNavigation', () => {
    it('routes selection through workspace search navigation before updating result state', () => {
        const calls: string[] = [];
        const navigate = vi.fn(() => calls.push('navigate'));
        const select = vi.fn(() => calls.push('select'));
        const activate = createWorkspacePdfSearchResultNavigation({
            results: ref([{pageIndex: 2}]),
            navigate,
            select,
        });

        activate(0);

        expect(navigate).toHaveBeenCalledWith(3, {navigationSource: 'search'});
        expect(select).toHaveBeenCalledWith(0);
        expect(calls).toEqual([
            'navigate',
            'select',
        ]);
    });
});
