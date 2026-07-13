interface IForegroundApplication {focus(options: { steal: true; }): void;}

interface IForegroundWindow {
    focus(): void;
    isDestroyed(): boolean;
    isMinimized(): boolean;
    isVisible(): boolean;
    restore(): void;
    show(): void;
}

interface IFocusWindowForUserOptions {
    application: IForegroundApplication;
    noFocus: boolean;
    platform?: NodeJS.Platform;
}

export function focusWindowForUser(
    window: IForegroundWindow,
    options: IFocusWindowForUserOptions,
) {
    if (options.noFocus || window.isDestroyed()) {
        return;
    }

    if (window.isMinimized()) {
        window.restore();
    }
    if (!window.isVisible()) {
        window.show();
    }

    window.focus();
    if ((options.platform ?? process.platform) === 'darwin') {
        options.application.focus({ steal: true });
    }
}
