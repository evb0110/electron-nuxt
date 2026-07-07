import type {
    ComputedRef,
    Ref,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IShutdownSaveFlushResponse,
    ISystemCapability,
} from '@contracts/electronApiSystem';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import { BrowserLogger } from '@app/utils/browserLogger';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IShutdownSaveFlushReportingDeps {
    workingCopyPath: TReadableRef<TDocumentRef | null>;
    hasPendingUnsavedChanges: TReadableRef<boolean>;
    saveForExternalRead: () => Promise<boolean> | boolean;
    systemCapability?: Pick<ISystemCapability, 'onShutdownSaveFlushRequest'>;
}

export const useShutdownSaveFlushReporting = (deps: IShutdownSaveFlushReportingDeps) => {
    const systemCapability = deps.systemCapability ?? getSystemCapability();
    const unsubscribe = systemCapability.onShutdownSaveFlushRequest(async (): Promise<IShutdownSaveFlushResponse> => {
        const capturedWorkingCopyPath = deps.workingCopyPath.value;
        if (!capturedWorkingCopyPath || !deps.hasPendingUnsavedChanges.value) {
            return {};
        }

        try {
            const flushed = await deps.saveForExternalRead();
            if (flushed) {
                return {flushedWorkingCopyPaths: [deps.workingCopyPath.value ?? capturedWorkingCopyPath]};
            }
        } catch (error) {
            BrowserLogger.warn('workspace', 'Failed to flush dirty working copy during shutdown', {
                error,
                workingCopyPath: capturedWorkingCopyPath,
            });
        }

        return {dirtyWorkingCopyPaths: [capturedWorkingCopyPath]};
    });

    tryOnScopeDispose(unsubscribe);
    return unsubscribe;
};
