import {
    BrowserWindow,
    app,
} from 'electron';

export type TAssistantReturnWindow = BrowserWindow | null;

export function rememberAssistantReturnWindow(parentWindow?: BrowserWindow | null): TAssistantReturnWindow {
    return parentWindow && !parentWindow.isDestroyed()
        ? parentWindow
        : BrowserWindow.getFocusedWindow();
}

export function focusAssistantReturnWindow(
    returnWindow: TAssistantReturnWindow,
    options: { noFocus?: boolean } = {},
) {
    const window = returnWindow && !returnWindow.isDestroyed()
        ? returnWindow
        : BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (!window || window.isDestroyed() || options.noFocus === true) {
        return;
    }
    if (window.isMinimized()) {
        window.restore();
    }
    if (!window.isVisible()) {
        window.show();
    }
    window.focus();
    if (process.platform === 'darwin') {
        app.focus({ steal: true });
    }
}
