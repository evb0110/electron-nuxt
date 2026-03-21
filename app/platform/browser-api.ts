import type { IPlatformApi } from '@contracts/platform-api';
import { normalizeAllowedExternalUrl } from '@contracts/external-url';
import { browserWindowTabsCapability } from '@app/platform/browser-window-tabs';
import { browserDjvuCapability } from '@app/platform/browser-api/djvu-capability';
import { createBrowserDocumentsCapability } from '@app/platform/browser-api/documents-capability';
import { browserOcrCapability } from '@app/platform/browser-api/ocr-capability';
import { createBrowserSearchCapability } from '@app/platform/browser-api/search-capability';
import { browserSettingsCapability } from '@app/platform/browser-api/settings-capability';
import { BrowserLogger } from '@app/utils/browser-logger';
import { browserUpdatesCapability } from '@app/platform/browser-api/updates-capability';

const {
    capability: browserSearchCapability,
    clearSearchCaches,
} = createBrowserSearchCapability();

const browserDocumentsCapability = createBrowserDocumentsCapability({clearSearchCaches});
const browserShellApi: IPlatformApi['shell'] = { openExternal(url: string) {
    if (typeof window === 'undefined') {
        return Promise.resolve();
    }

    const sanitizedUrl = normalizeAllowedExternalUrl(url);
    if (!sanitizedUrl) {
        BrowserLogger.warn('shell', 'Blocked external URL with unsupported protocol', { url });
        return Promise.resolve();
    }

    const openedWindow = window.open(sanitizedUrl, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
        BrowserLogger.warn('shell', 'Failed to open external URL', { url: sanitizedUrl });
    }

    return Promise.resolve();
} };

export const browserPlatformApi = {
    documents: browserDocumentsCapability,
    ocr: browserOcrCapability,
    search: browserSearchCapability,
    djvu: browserDjvuCapability,
    settings: browserSettingsCapability,
    updates: browserUpdatesCapability,
    windowTabs: browserWindowTabsCapability,
    shell: browserShellApi,
} satisfies IPlatformApi;
