import { createSearchReadinessPoll } from '@app/modules/workspace-shell/composables/createSearchReadinessPoll';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

export function createDeferredWorkspaceSearch<TIdentity, TOptions>(options: {
    tabId: string;
    pollIntervalMs: number;
    timeoutMs: number;
    isReady: () => boolean;
    readDiagnostics: () => Record<string, unknown>;
    readIdentity: () => TIdentity;
    isIdentityCurrent: (identity: TIdentity) => boolean;
    readQuery: () => string;
    readOptions: () => TOptions;
    restoreSearch: (query: string, searchOptions: TOptions) => void;
    waitForDocumentOpenSettled: () => Promise<unknown>;
    handleSearch: () => Promise<unknown>;
}) {
    const poll = createSearchReadinessPoll(options.pollIntervalMs);

    const waitUntilReady = async () => {
        if (options.isReady()) {
            return true;
        }
        BrowserLogger.diagnostic('pdf-search', 'Delaying search until document open settles', {
            tabId: options.tabId,
            ...options.readDiagnostics(),
        });
        let settleFinished = false;
        const settlePromise = options.waitForDocumentOpenSettled()
            .catch((error) => {
                BrowserLogger.warn('pdf-search', 'Document open settle wait failed before search', {
                    tabId: options.tabId,
                    error: getErrorMessage(error),
                });
            })
            .finally(() => {
                settleFinished = true;
            });
        const deadline = Date.now() + options.timeoutMs;
        while (Date.now() < deadline) {
            if (poll.signal.aborted) {
                return false;
            }
            if (options.isReady()) {
                return true;
            }
            const didContinue = settleFinished
                ? await poll.wait()
                : await Promise.race([
                    settlePromise,
                    poll.wait(),
                ]);
            if (didContinue === false) {
                return false;
            }
            await nextTick();
        }
        BrowserLogger.warn('pdf-search', 'Search requested before document became ready', {
            tabId: options.tabId,
            ...options.readDiagnostics(),
        });
        return options.isReady();
    };

    const handleSearchWhenDocumentReady = async () => {
        const requestedIdentity = options.readIdentity();
        const requestedQuery = options.readQuery();
        const requestedOptions = options.readOptions();
        if (!await waitUntilReady() || !options.isIdentityCurrent(requestedIdentity)) {
            return;
        }
        if (!options.readQuery() && requestedQuery) {
            options.restoreSearch(requestedQuery, requestedOptions);
        }
        await options.handleSearch();
    };

    return {
        dispose: poll.dispose,
        handleSearchWhenDocumentReady,
    };
}
