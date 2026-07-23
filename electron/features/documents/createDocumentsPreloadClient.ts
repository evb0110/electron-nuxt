import type {IpcRenderer} from 'electron';
import type {
    IDocumentsCapability,
    IDocumentsMenuCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
} from '@contracts/electronApiDocuments';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';

type TDocumentsMigratedMethod =
    | keyof IDocumentsMenuCapability
    | keyof IDocumentsPickerCapability
    | keyof IDocumentsRecentFilesCapability
    | keyof IDocumentsWindowCapability;
type TDocumentsOptionalDirectMethod =
    | 'createCombinedPdfFromFiles'
    | 'openFolderDialogStructured'
    | 'showItemInFolderStructured';

export function createDocumentsPreloadClient(
    ipcRenderer: IpcRenderer,
): Omit<IDocumentsCapability, TDocumentsMigratedMethod>
    & Partial<Pick<IDocumentsCapability, TDocumentsOptionalDirectMethod>> {
    return createDocumentsPreloadFileClient(ipcRenderer);
}
