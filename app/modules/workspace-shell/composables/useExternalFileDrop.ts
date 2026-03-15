import { useDropZone } from '@vueuse/core';
import { getElectronAPI } from '@app/utils/platform';

interface IUseExternalFileDropOptions {openPathInAppropriateTab: (path: string) => Promise<void>;}

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

    const electronApi = getElectronAPI();
    const paths: string[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < dataTransfer.files.length; i++) {
        const file = dataTransfer.files[i];
        if (!file) {
            continue;
        }

        const path = electronApi.documents.getPathForFile(file);
        if (!path || seen.has(path)) {
            continue;
        }

        const lowerPath = path.toLowerCase();
        if (
            lowerPath.endsWith('.pdf')
            || lowerPath.endsWith('.djvu')
            || lowerPath.endsWith('.djv')
            || lowerPath.endsWith('.png')
            || lowerPath.endsWith('.jpg')
            || lowerPath.endsWith('.jpeg')
            || lowerPath.endsWith('.tif')
            || lowerPath.endsWith('.tiff')
            || lowerPath.endsWith('.bmp')
            || lowerPath.endsWith('.webp')
            || lowerPath.endsWith('.gif')
        ) {
            seen.add(path);
            paths.push(path);
        }
    }

    return paths;
}

export function useExternalFileDrop(options: IUseExternalFileDropOptions) {
    const { openPathInAppropriateTab } = options;
    let queue: Promise<void> = Promise.resolve();
    let lifecycleToken = 0;
    let disposed = false;

    async function processDroppedPaths(
        paths: string[],
        tokenAtSchedule: number,
    ) {
        if (disposed || tokenAtSchedule !== lifecycleToken) {
            return;
        }

        for (const path of paths) {
            if (disposed || tokenAtSchedule !== lifecycleToken) {
                return;
            }
            await openPathInAppropriateTab(path);
        }
    }

    function shouldHandleDropEvent(event: DragEvent) {
        if (disposed) {
            return false;
        }
        if (event.defaultPrevented || isSidebarDropArea(event)) {
            return false;
        }
        return hasExternalFilePayload(event.dataTransfer);
    }

    function enqueueDroppedPaths(paths: string[]) {
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

    const dropTarget = typeof document !== 'undefined' ? document : null;

    useDropZone(dropTarget, {
        dataTypes: ['Files'],
        preventDefaultForUnhandled: true,
        onOver: (_files, event) => {
            if (!shouldHandleDropEvent(event)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'copy';
            }
        },
        onDrop: (_files, event) => {
            if (!shouldHandleDropEvent(event)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            enqueueDroppedPaths(getDroppedDocumentPaths(event.dataTransfer));
        },
    });

    function cleanup() {
        if (disposed) {
            return;
        }
        disposed = true;
        lifecycleToken += 1;
        queue = Promise.resolve();
    }

    return { cleanup };
}
