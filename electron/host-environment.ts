import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import type {
    IHostEnvironmentSnapshot,
    THostPlatform,
} from '@contracts/electron-api-host';
import { getAllRegisteredAppWindows } from '@electron/window/registry';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('host-env');

const HOST_ENV_CHANGE_CHANNEL = 'host:environmentChanged';

function resolvePlatform(): THostPlatform {
    if (process.platform === 'darwin') {
        return 'darwin';
    }
    if (process.platform === 'win32') {
        return 'win32';
    }
    return 'linux';
}

function readScaleFactorForWindow(window: BrowserWindow | null) {
    try {
        if (window && !window.isDestroyed()) {
            const bounds = window.getBounds();
            const display = screen.getDisplayNearestPoint({
                x: bounds.x + Math.floor(bounds.width / 2),
                y: bounds.y + Math.floor(bounds.height / 2),
            });
            return display.scaleFactor;
        }
    } catch (error) {
        logger.warn(`Failed to read window display scale factor: ${getErrorMessage(error)}`);
    }

    try {
        return screen.getPrimaryDisplay().scaleFactor;
    } catch (error) {
        logger.warn(`Failed to read primary display scale factor: ${getErrorMessage(error)}`);
        return 1;
    }
}

export function snapshotHostEnvironmentForWindow(window: BrowserWindow | null): IHostEnvironmentSnapshot {
    return {
        platform: resolvePlatform(),
        osScaleFactor: readScaleFactorForWindow(window),
    };
}

function broadcastHostEnvironmentForWindow(window: BrowserWindow) {
    if (window.isDestroyed()) {
        return;
    }
    const snapshot = snapshotHostEnvironmentForWindow(window);
    try {
        window.webContents.send(HOST_ENV_CHANGE_CHANNEL, snapshot);
    } catch (error) {
        logger.warn(`Failed to send host environment update: ${getErrorMessage(error)}`);
    }
}

function broadcastHostEnvironmentToAllWindows() {
    for (const window of getAllRegisteredAppWindows()) {
        broadcastHostEnvironmentForWindow(window);
    }
}

let displayWatcherInstalled = false;

export function installHostEnvironmentDisplayWatcher() {
    if (displayWatcherInstalled) {
        return;
    }
    displayWatcherInstalled = true;

    const handleDisplayChange = () => {
        broadcastHostEnvironmentToAllWindows();
    };

    screen.on('display-metrics-changed', handleDisplayChange);
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);
}

export function attachHostEnvironmentToWindow(window: BrowserWindow) {
    const handleMove = () => {
        broadcastHostEnvironmentForWindow(window);
    };

    window.on('move', handleMove);
    window.on('moved', handleMove);
    window.once('closed', () => {
        window.removeListener('move', handleMove);
        window.removeListener('moved', handleMove);
    });
}
