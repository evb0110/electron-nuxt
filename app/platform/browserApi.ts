import type { IPlatformApi } from '@contracts/platformApi';
import type { IAgentMcpIntegrationStatus } from '@contracts/agent';
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

const browserDocumentCapabilities = createBrowserDocumentsCapability({clearSearchCaches});
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

const browserAgentApi: IPlatformApi['agent'] = {
    onWorkspaceSnapshotRequest: () => () => {},
    submitWorkspaceSnapshot: () => Promise.resolve(false),
    onCommandRequest: () => () => {},
    submitCommandResponse: () => Promise.resolve(false),
    getMcpIntegrationStatus: () => Promise.resolve(createBrowserAgentMcpStatus()),
    setMcpIntegrationEnabled: () => Promise.resolve({
        ok: false,
        status: createBrowserAgentMcpStatus(),
    }),
};

function createBrowserAgentMcpStatus(): IAgentMcpIntegrationStatus {
    return {
        enabled: false,
        serverName: 'evb_viewer',
        serverUrl: '',
        serverRunning: false,
        codexInstalled: false,
        codexPath: null,
        codexConfigured: false,
        codexRegistrationState: 'unknown',
        installUrl: 'https://developers.openai.com/codex/app',
        lastCheckedAt: new Date().toISOString(),
    };
}

export const browserPlatformApi = {
    documents: browserDocumentCapabilities.documents,
    pageOps: browserDocumentCapabilities.pageOps,
    imageExport: browserDocumentCapabilities.imageExport,
    ocr: browserOcrCapability,
    search: browserSearchCapability,
    djvu: browserDjvuCapability,
    settings: browserSettingsCapability,
    updates: browserUpdatesCapability,
    windowTabs: browserWindowTabsCapability,
    shell: browserShellApi,
    host: browserHostCapability,
    agent: browserAgentApi,
} satisfies IPlatformApi;
