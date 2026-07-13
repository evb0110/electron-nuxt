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
    const errorDiagnostic = error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack ?? null,
            cause: error.cause instanceof Error
                ? {
                    name: error.cause.name,
                    message: error.cause.message,
                    stack: error.cause.stack ?? null,
                }
                : error.cause ?? null,
        }
        : error;
    BrowserLogger.error('workspace-host', 'Document tab crashed; isolating the failed workspace', {
        tabId: options.tabId,
        component: componentName,
        info,
        error: errorDiagnostic,
    });
    options.failActiveTransaction();
    options.releaseWorkspace();
    options.resetWorkspaceLoad();
    options.setError(error);
}
