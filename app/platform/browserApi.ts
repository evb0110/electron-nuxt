import type { IPlatformApi } from '@contracts/platformApi';
import { inspectAllowedExternalUrl } from '@contracts/externalUrl';
import { browserWindowTabsCapability } from '@app/platform/browserWindowTabs';
import { browserDjvuCapability } from '@app/platform/browser-api/djvuCapability';
import { createBrowserDocumentsCapability } from '@app/platform/browser-api/documentsCapability';
import { browserHostCapability } from '@app/platform/browser-api/hostCapability';
import { browserOcrCapability } from '@app/platform/browser-api/ocrCapability';
import { createBrowserSearchCapability } from '@app/platform/browser-api/searchCapability';
import { browserSettingsCapability } from '@app/platform/browser-api/settingsCapability';
import { BrowserLogger } from '@app/utils/browserLogger';
import { browserUpdatesCapability } from '@app/platform/browser-api/updatesCapability';

const {
    capability: browserSearchCapability,
    clearSearchCaches,
} = createBrowserSearchCapability();

const browserDocumentsCapability = createBrowserDocumentsCapability({clearSearchCaches});
const browserShellApi: IPlatformApi['shell'] = { openExternal(url: string) {
    if (typeof window === 'undefined') {
        return Promise.resolve();
    }

    const decision = inspectAllowedExternalUrl(url);
    if (!decision.ok) {
        BrowserLogger.warn('shell', 'Blocked external URL', {
            protocol: decision.protocol ?? null,
            reason: decision.reason,
            url,
        });
        return Promise.resolve();
    }

    const openedWindow = window.open(decision.normalizedUrl, '_blank', 'noopener,noreferrer');
    if (!openedWindow) {
        BrowserLogger.warn('shell', 'Failed to open external URL', { url: decision.normalizedUrl });
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
    host: browserHostCapability,
} satisfies IPlatformApi;
