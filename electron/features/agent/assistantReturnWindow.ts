import {
    BrowserWindow,
    app,
} from 'electron';
import { focusWindowForUser } from '@electron/window/focusWindowForUser';

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
    if (!window) {
        return;
    }

    focusWindowForUser(window, {
        application: app,
        noFocus: options.noFocus === true,
    });
}
