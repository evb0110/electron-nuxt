import { formatBrowserPageTitle } from '@app/utils/formatBrowserPageTitle';

interface IResolveAppWindowTitleOptions {
    appTitle: string;
    webTitle: string;
    fileName?: string | null;
    isBrowserRuntime: boolean;
}

function normalizeTitle(value: string | null | undefined) {
    return value?.trim() ?? '';
}

export function resolveAppWindowTitle(options: IResolveAppWindowTitleOptions) {
    const appTitle = normalizeTitle(options.appTitle);
    const webTitle = normalizeTitle(options.webTitle);
    const fileName = normalizeTitle(options.fileName);

    if (!fileName) {
        return options.isBrowserRuntime ? webTitle : appTitle;
    }

    if (!options.isBrowserRuntime) {
        return fileName;
    }

    return formatBrowserPageTitle({
        appName: webTitle,
        fileName,
    });
}

export function formatWebTitleTemplate(pageTitle: string | null | undefined, appTitle: string) {
    const normalizedPageTitle = normalizeTitle(pageTitle);
    const normalizedAppTitle = normalizeTitle(appTitle);

    if (!normalizedPageTitle || normalizedPageTitle === normalizedAppTitle) {
        return normalizedAppTitle;
    }

    return `${normalizedPageTitle} — ${normalizedAppTitle}`;
}
