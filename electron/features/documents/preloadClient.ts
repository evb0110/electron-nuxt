import type {IpcRenderer} from 'electron';
import type { IDocumentsCapability } from '@contracts/platformApi';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/preloadFileClient';
import { createDocumentsPreloadMenuClient } from '@electron/features/documents/preloadMenuClient';
import { createDocumentsPreloadPageOpsClient } from '@electron/features/documents/preloadPageOpsClient';

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
