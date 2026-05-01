import { useEventListener } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/platform-api';
import { getDocumentPathForFile } from '@app/utils/platform-documents';
import { isSupportedWorkspaceDocumentPath } from '@app/utils/supported-document-paths';

interface IUseExternalFileDropOptions {openPathsInAppropriateTab: (paths: TDocumentRef[]) => Promise<void>;}

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

function getDroppedDocumentPaths(dataTransfer: DataTransfer | null) {
    if (!dataTransfer) {
        return [];
    }

    const paths: TDocumentRef[] = [];
    const seen = new Set<TDocumentRef>();

    for (let i = 0; i < dataTransfer.files.length; i++) {
        const file = dataTransfer.files[i];
        if (!file) {
            continue;
        }

        const path = getDocumentPathForFile(file);
        if (!path || seen.has(path)) {
            continue;
        }

        if (isSupportedWorkspaceDocumentPath(path)) {
            seen.add(path);
            paths.push(path);
        }
    }

    return paths;
}

export function useExternalFileDrop(options: IUseExternalFileDropOptions) {
    const { openPathsInAppropriateTab } = options;
    let queue: Promise<void> = Promise.resolve();
    let lifecycleToken = 0;
    let disposed = false;

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
        if (isSidebarDropArea(event)) {
            return false;
        }
        return hasExternalFilePayload(event.dataTransfer);
    }

    function enqueueDroppedPaths(paths: TDocumentRef[]) {
        if (paths.length === 0) {
            return;
        }

        const tokenAtSchedule = lifecycleToken;
        queue = queue
            .catch(() => {
                // Keep the queue flowing after a single file-open failure.
            })
            .then(async () => {
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
        enqueueDroppedPaths(getDroppedDocumentPaths(event.dataTransfer));
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
}
