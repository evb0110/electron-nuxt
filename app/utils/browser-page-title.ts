interface IFormatBrowserPageTitleOptions {
    appName: string;
    fileName?: string | null;
}

export function formatBrowserPageTitle(options: IFormatBrowserPageTitleOptions) {
    const appName = options.appName.trim();
    const fileName = options.fileName?.trim() ?? '';

    if (!fileName) {
        return appName;
    }

    return `${fileName} - ${appName}`;
}
