import type { IAgentAssistantPanelControllerProps } from '@app/modules/agent-panel/composables/useAgentAssistantPanelController';

export function createAgentAssistantPanelControllerProps(
    read: () => Readonly<IAgentAssistantPanelControllerProps>,
) {
    return {
        get activeDocumentName() {
            return read().activeDocumentName ?? null;
        },
        get chatScope() {
            return read().chatScope ?? null;
        },
        get hasActiveDocument() {
            return read().hasActiveDocument ?? false;
        },
        get hasAnyDocument() {
            return read().hasAnyDocument ?? false;
        },
        get width() {
            return read().width;
        },
        get isResizing() {
            return read().isResizing ?? false;
        },
    } satisfies Readonly<IAgentAssistantPanelControllerProps>;
}
