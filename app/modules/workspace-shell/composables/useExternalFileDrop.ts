import { useEventListener } from '@vueuse/core';
import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { getDocumentPickerCapability } from '@app/utils/platformDocuments';
import { isSupportedWorkspaceDocumentPath } from '@app/utils/supportedDocumentPaths';

interface IUseExternalFileDropOptions {
    openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;
    isEnabled?: Ref<boolean>;
}

function hasExternalFilePayload(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return false;
    }
    return Array.from(dataTransfer.types).includes('Files');
}

function isSidebarDropArea(event: DragEvent) {
    if (typeof Element === 'undefined') {
        return false;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('.pdf-sidebar-pages-thumbnails'));
}

function isToolDropArea(event: DragEvent) {
    if (typeof Element === 'undefined') {
        return false;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
        return false;
    }
    return Boolean(target.closest('[data-combine-page]'));
}

async function getDroppedDocumentPaths(
    droppedFiles: File[],
    notifyRegistrationFailure: (error: unknown) => void,
) {
    const paths: TDocumentRef[] = [];
    const seen = new Set<TDocumentRef>();
    const documentPicker = getDocumentPickerCapability();

    for (const file of droppedFiles) {
        let droppedPaths: TDocumentRef[];
        try {
            droppedPaths = await documentPicker.registerFilesForOpen([file]);
        } catch (error) {
            notifyRegistrationFailure(error);
            continue;
        }

        for (const path of droppedPaths) {
            if (!path || seen.has(path)) {
                continue;
            }

            if (isSupportedWorkspaceDocumentPath(path)) {
                seen.add(path);
                paths.push(path);
            }
        }
    }

    return paths;
}

export const useExternalFileDrop = (options: IUseExternalFileDropOptions) => {
    const {
        openPathsInAppropriateTab,
        isEnabled,
    } = options;
    const { t } = useTypedI18n();
    const toast = useToast();
    let queue: Promise<void> = Promise.resolve();
    let lifecycleToken = 0;
    let disposed = false;

    function notifyRegistrationFailure(error: unknown) {
        toast.add({
            color: 'error',
            title: t('errors.file.open'),
            description: getErrorMessage(error),
        });
    }

    async function processDroppedPaths(
        paths: TDocumentRef[],
        tokenAtSchedule: number,
    ) {
        if (disposed || tokenAtSchedule !== lifecycleToken) {
            return;
        }

        await openPathsInAppropriateTab(paths);
    }

    function shouldHandleDropEvent(event: DragEvent) {
        if (disposed) {
            return false;
        }
        if (isEnabled && !isEnabled.value) {
            return false;
        }
        if (isSidebarDropArea(event)) {
            return false;
        }
        if (isToolDropArea(event)) {
            return false;
        }
        return hasExternalFilePayload(event.dataTransfer);
    }

    function enqueueDroppedFiles(files: File[]) {
        if (files.length === 0) {
            return;
        }

        const tokenAtSchedule = lifecycleToken;
        queue = queue
            .catch(() => {
                // Keep the queue flowing after a single file-open failure.
            })
            .then(async () => {
                const paths = await getDroppedDocumentPaths(files, notifyRegistrationFailure);
                if (paths.length === 0) {
                    return;
                }
                await processDroppedPaths(paths, tokenAtSchedule);
            });
    }

    const stopDragOver = useEventListener(typeof window !== 'undefined' ? window : undefined, 'dragover', (event: DragEvent) => {
        if (!shouldHandleDropEvent(event)) {
            return;
        }

        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    }, { capture: true });

    const stopDrop = useEventListener(typeof window !== 'undefined' ? window : undefined, 'drop', (event: DragEvent) => {
        if (!shouldHandleDropEvent(event)) {
            return;
        }

        event.preventDefault();
        enqueueDroppedFiles(Array.from(event.dataTransfer?.files ?? []));
    }, { capture: true });

    function cleanup() {
        if (disposed) {
            return;
        }
        disposed = true;
        lifecycleToken += 1;
        queue = Promise.resolve();
        stopDragOver?.();
        stopDrop?.();
    }

    return { cleanup };
};
