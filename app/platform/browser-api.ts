import type { IElectronAPI } from '@contracts/electron-api';
import { browserWindowTabsCapability } from '@app/platform/browser-window-tabs';
import { browserDjvuCapability } from '@app/platform/browser-api/djvu-capability';
import { createBrowserDocumentsCapability } from '@app/platform/browser-api/documents-capability';
import { browserOcrCapability } from '@app/platform/browser-api/ocr-capability';
import { createBrowserSearchCapability } from '@app/platform/browser-api/search-capability';
import { browserSettingsCapability } from '@app/platform/browser-api/settings-capability';
import { browserShellCapability } from '@app/platform/browser-api/shell-capability';
import { browserUpdatesCapability } from '@app/platform/browser-api/updates-capability';

const {
    capability: browserSearchCapability,
    clearSearchCaches,
} = createBrowserSearchCapability();

const browserDocumentsCapability = createBrowserDocumentsCapability({clearSearchCaches});

export const browserPlatformApi: IElectronAPI = {
    documents: browserDocumentsCapability,
    ocr: browserOcrCapability,
    search: browserSearchCapability,
    djvu: browserDjvuCapability,
    settings: browserSettingsCapability,
    updates: browserUpdatesCapability,
    windowTabs: browserWindowTabsCapability,
    shell: browserShellCapability,
};
