import type {IpcRenderer} from 'electron';
import type { IDocumentsCapability } from '@contracts/electronApiDocuments';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { createDocumentsPreloadMenuClient } from '@electron/features/documents/createDocumentsPreloadMenuClient';

export function createDocumentsPreloadClient(
    ipcRenderer: IpcRenderer,
): Omit<IDocumentsCapability, 'getPathForFile' | 'getPathsForFiles'> {
    const fileClient = createDocumentsPreloadFileClient(ipcRenderer);
    const menuClient = createDocumentsPreloadMenuClient(ipcRenderer);

    return {
        ...fileClient,
        ...menuClient,
    };
}
