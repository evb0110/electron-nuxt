import type {IpcRenderer} from 'electron';
import type { IDocumentsCapability } from '@contracts/platform-api';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/preload-file-client';
import { createDocumentsPreloadMenuClient } from '@electron/features/documents/preload-menu-client';
import { createDocumentsPreloadPageOpsClient } from '@electron/features/documents/preload-page-ops-client';

export function createDocumentsPreloadClient(
    ipcRenderer: IpcRenderer,
): Omit<IDocumentsCapability, 'getPathForFile'> {
    const fileClient = createDocumentsPreloadFileClient(ipcRenderer);
    const menuClient = createDocumentsPreloadMenuClient(ipcRenderer);
    const pageOpsClient = createDocumentsPreloadPageOpsClient(ipcRenderer);

    return {
        ...fileClient,
        ...menuClient,
        pageOps: pageOpsClient,
    };
}
