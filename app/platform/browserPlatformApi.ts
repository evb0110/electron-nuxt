import type { IPlatformApi } from '@contracts/platformApi';
import { inspectAllowedExternalUrl } from '@contracts/externalUrl';
import { browserWindowTabsCapability } from '@app/platform/browserWindowTabs';
import {
    browserAgentCapability,
    browserDjvuCapability,
    browserHostCapability,
    browserOcrCapability,
    browserSettingsCapability,
    browserUpdatesCapability,
    createBrowserDocumentsCapability,
    createBrowserSearchCapability,
} from '@app/platform/browser-api/public';
import { BrowserLogger } from '@app/utils/browserLogger';

const {
    capability: browserSearchCapability,
    clearSearchCaches,
} = createBrowserSearchCapability();

const browserDocumentCapabilities = createBrowserDocumentsCapability({clearSearchCaches});
const browserSystemApi: IPlatformApi['system'] = { getMemoryInfo: () => null };
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
    documents: browserDocumentCapabilities.documents,
    documentPicker: browserDocumentCapabilities.documentPicker,
    documentOpen: browserDocumentCapabilities.documentOpen,
    documentWorkingCopy: browserDocumentCapabilities.documentWorkingCopy,
    documentFiles: browserDocumentCapabilities.documentFiles,
    documentPdf: browserDocumentCapabilities.documentPdf,
    documentRecentFiles: browserDocumentCapabilities.documentRecentFiles,
    documentWindow: browserDocumentCapabilities.documentWindow,
    documentMenu: browserDocumentCapabilities.documentMenu,
    pageOps: browserDocumentCapabilities.pageOps,
    imageExport: browserDocumentCapabilities.imageExport,
    ocr: browserOcrCapability,
    search: browserSearchCapability,
    djvu: browserDjvuCapability,
    settings: browserSettingsCapability,
    system: browserSystemApi,
    updates: browserUpdatesCapability,
    windowTabs: browserWindowTabsCapability,
    shell: browserShellApi,
    host: browserHostCapability,
    agent: browserAgentCapability,
} satisfies IPlatformApi;
