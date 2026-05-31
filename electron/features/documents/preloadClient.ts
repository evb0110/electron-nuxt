import type {IpcRenderer} from 'electron';
import type { IDocumentsCapability } from '@contracts/platformApi';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/preloadFileClient';
import { createDocumentsPreloadMenuClient } from '@electron/features/documents/preloadMenuClient';

export function createDocumentsPreloadClient(
    ipcRenderer: IpcRenderer,
): Omit<IDocumentsCapability, 'getPathForFile'> {
    const fileClient = createDocumentsPreloadFileClient(ipcRenderer);
    const menuClient = createDocumentsPreloadMenuClient(ipcRenderer);

    return {
        ...fileClient,
        ...menuClient,
    };
}
