import type {
    ComputedRef,
    Ref,
} from 'vue';
import {
    tryOnScopeDispose,
    useEventListener,
} from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IShutdownSaveFlushResponse,
    ISystemCapability,
} from '@contracts/systemPlatformFeature';
import { getSystemCapability } from '@app/utils/getSystemCapability';
import { BrowserLogger } from '@app/utils/browserLogger';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IShutdownSaveFlushReportingDeps {
    workingCopyPath: TReadableRef<TDocumentRef | null>;
    hasPendingUnsavedChanges: TReadableRef<boolean>;
    saveForExternalRead: () => Promise<boolean> | boolean;
    systemCapability?: Pick<ISystemCapability, 'onShutdownSaveFlushRequest'>;
}

export function preventBrowserUnloadWhenDirty(
    event: BeforeUnloadEvent,
    hasPendingUnsavedChanges: boolean,
) {
    if (!hasPendingUnsavedChanges) {
        return false;
    }

    event.preventDefault();
    // Retain the legacy assignment alongside preventDefault() for browsers
    // that still require it to display their built-in confirmation dialog.
    event.returnValue = true;
    return true;
}

export const useBrowserDirtyUnloadGuard = (hasPendingUnsavedChanges: () => boolean) => {
    const targetWindow = typeof window === 'undefined' ? undefined : window;
    useEventListener(targetWindow, 'beforeunload', (event: BeforeUnloadEvent) => {
        preventBrowserUnloadWhenDirty(event, hasPendingUnsavedChanges());
    });
};

function getShutdownSaveFlushErrorCode(error: unknown) {
    if (
        typeof error !== 'object'
        || error === null
        || !('code' in error)
        || typeof error.code !== 'string'
    ) {
        return undefined;
    }
    return error.code;
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
                errorCode: getShutdownSaveFlushErrorCode(error),
                workingCopyPath: capturedWorkingCopyPath,
            });
        }

        return {dirtyWorkingCopyPaths: [capturedWorkingCopyPath]};
    });

    tryOnScopeDispose(unsubscribe);
    return unsubscribe;
};
