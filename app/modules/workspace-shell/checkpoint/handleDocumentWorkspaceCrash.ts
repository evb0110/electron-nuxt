import { BrowserLogger } from '@app/utils/browserLogger';

interface IDocumentWorkspaceCrashOptions {
    failActiveTransaction: () => void;
    releaseWorkspace: () => void;
    resetWorkspaceLoad: () => void;
    setError: (error: unknown) => void;
    tabId: string;
}

export function handleDocumentWorkspaceCrash(
    error: unknown,
    componentName: string | null,
    info: string,
    options: IDocumentWorkspaceCrashOptions,
) {
    BrowserLogger.error('workspace-host', 'Document tab crashed; isolating the failed workspace', {
        tabId: options.tabId,
        component: componentName,
        info,
        error,
    });
    options.failActiveTransaction();
    options.releaseWorkspace();
    options.resetWorkspaceLoad();
    options.setError(error);
}
