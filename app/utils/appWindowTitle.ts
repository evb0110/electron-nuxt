import { formatBrowserPageTitle } from '@app/utils/formatBrowserPageTitle';

interface IResolveAppWindowTitleOptions {
    appTitle: string;
    webTitle: string;
    fileName?: string | null;
    isBrowserRuntime: boolean;
}

const MAX_WINDOW_TITLE_FILE_NAME_LENGTH = 60;

function normalizeTitle(value: string | null | undefined) {
    return value?.trim() ?? '';
}

function truncateWindowTitleFileName(value: string) {
    if (value.length <= MAX_WINDOW_TITLE_FILE_NAME_LENGTH) {
        return value;
    }

    return `${value.slice(0, MAX_WINDOW_TITLE_FILE_NAME_LENGTH - 1).trimEnd()}…`;
}

export function resolveAppWindowTitle(options: IResolveAppWindowTitleOptions) {
    const appTitle = normalizeTitle(options.appTitle);
    const webTitle = normalizeTitle(options.webTitle);
    const fileName = truncateWindowTitleFileName(normalizeTitle(options.fileName));

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
