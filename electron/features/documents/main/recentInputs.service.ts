import { uniq } from 'es-toolkit/array';
import { addRecentFile } from '@electron/recentFiles';
import { updateRecentFilesMenu } from '@electron/menu';
import { allowOpenPaths } from '@electron/ipc/openPathCapabilities';

type TOpenPathOwner = number | Electron.WebContents;

export async function addRecentInputs(paths: string[], owner?: TOpenPathOwner) {
    const uniquePaths = uniq(paths);
    allowOpenPaths(uniquePaths, owner);
    for (const path of uniquePaths) {
        await addRecentFile(path);
    }
    updateRecentFilesMenu();
}
