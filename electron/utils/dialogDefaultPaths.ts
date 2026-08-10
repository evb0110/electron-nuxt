import { app } from 'electron';
import { dirname } from 'path';

export function getDocumentsDialogDefaultPath() {
    return app.getPath('documents');
}

export function getWorkingCopyDialogDefaultPath(workingCopyPath: string) {
    return dirname(workingCopyPath);
}
