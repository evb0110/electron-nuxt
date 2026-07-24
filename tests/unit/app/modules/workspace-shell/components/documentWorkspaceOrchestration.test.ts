import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createDeferredWorkspaceSearch } from '@app/modules/workspace-shell/composables/createDeferredWorkspaceSearch';

describe('DocumentWorkspace owner behavior', () => {
    it('fences deferred search replay to the document identity that requested it', async () => {
        const settle = Promise.withResolvers<undefined>();
        const handleSearch = vi.fn(async () => {});
        let identity = 'revision-1';
        let ready = false;
        const search = createDeferredWorkspaceSearch({
            tabId: 'tab-1',
            pollIntervalMs: 1,
            timeoutMs: 100,
            isReady: () => ready,
            readDiagnostics: () => ({}),
            readIdentity: () => identity,
            isIdentityCurrent: requested => requested === identity,
            readQuery: () => 'needle',
            readOptions: () => ({caseSensitive: false}),
            restoreSearch: vi.fn(),
            waitForDocumentOpenSettled: () => settle.promise,
            handleSearch,
        });

        const pendingSearch = search.handleSearchWhenDocumentReady();
        await Promise.resolve();
        identity = 'revision-2';
        ready = true;
        settle.resolve(undefined);
        await pendingSearch;

        expect(handleSearch).not.toHaveBeenCalled();
        search.dispose();
    });
});
