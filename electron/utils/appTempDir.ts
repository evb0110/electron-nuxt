import { app } from 'electron';
import { mkdirSync } from 'fs';
import { join } from 'path';

const APP_TEMP_DIR_NAME = 'evb-viewer';

export function getAppTempDirPath() {
    return join(app.getPath('temp'), APP_TEMP_DIR_NAME);
}

export function getAppTempDir() {
    const tempDir = getAppTempDirPath();
    mkdirSync(tempDir, { recursive: true });
    return tempDir;
}
