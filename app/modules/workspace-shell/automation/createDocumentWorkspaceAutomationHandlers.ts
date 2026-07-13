import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';

interface IDocumentWorkspaceAutomationContext extends Record<string, unknown> {
    currentPage: number;
    path: unknown;
    tabId: string;
    totalPages: number;
}

interface ICreateDocumentWorkspaceAutomationHandlersOptions {
    getContext: () => IDocumentWorkspaceAutomationContext;
    handleInitialVisualReady: () => void;
    handleSave: () => Promise<boolean>;
}

export function createDocumentWorkspaceAutomationHandlers(
    options: ICreateDocumentWorkspaceAutomationHandlersOptions,
) {
    function handleInitialVisualReady() {
        options.handleInitialVisualReady();
        emitAutomationEvent('first-page-rendered', options.getContext());
    }

    async function handleSave() {
        const saved = await options.handleSave();
        if (saved) {
            const {
                path,
                tabId,
            } = options.getContext();
            emitAutomationEvent('save-committed', {
                path,
                tabId,
            });
        }
        return saved;
    }

    return {
        handleInitialVisualReady,
        handleSave,
    };
}
