import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { emitAutomationEvent } from '@app/modules/workspace-shell/automation/automationReadinessEvents';

interface IUseDocumentOpenedAutomationEventOptions {
    currentPage: Ref<number>;
    originalPath: Ref<TDocumentRef | null>;
    tabId: string;
    totalPages: Ref<number>;
    waitForDocumentOpenSettled: () => Promise<unknown>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

export const useDocumentOpenedAutomationEvent = (
    options: IUseDocumentOpenedAutomationEventOptions,
) => {
    let latestOpenToken: symbol | null = null;

    watch([
        options.workingCopyPath,
        options.originalPath,
    ], ([
        nextWorkingCopyPath,
        nextOriginalPath,
    ]) => {
        const documentPath = nextOriginalPath ?? nextWorkingCopyPath;
        if (!documentPath) {
            return;
        }
        const openToken = Symbol('document-opened');
        latestOpenToken = openToken;
        void options.waitForDocumentOpenSettled()
            .then(() => {
                if (latestOpenToken !== openToken) {
                    return;
                }
                emitAutomationEvent('document-opened', {
                    currentPage: options.currentPage.value,
                    path: documentPath,
                    tabId: options.tabId,
                    totalPages: options.totalPages.value,
                });
            })
            .catch(() => {});
    });
};
