import { BrowserWindow } from 'electron';
import type { IDocumentRevisionChangedEvent } from '@contracts/documentRevision';
import { DOCUMENTS_EVENT_CHANNELS } from '@electron/features/documents/contract';
import { onWorkingCopyRevisionChanged } from '@electron/file-access/documentRevisionStore';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('document-revision-events');
let unsubscribeRevisionBridge: (() => void) | null = null;

export function registerDocumentRevisionEventBridge(): void {
    if (unsubscribeRevisionBridge) {
        return;
    }

    unsubscribeRevisionBridge = onWorkingCopyRevisionChanged((event: IDocumentRevisionChangedEvent) => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (window.isDestroyed() || window.webContents.isDestroyed()) {
                continue;
            }
            try {
                window.webContents.send(DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged, event);
            } catch (error) {
                logger.debug(`Failed to send document revision event: ${getErrorMessage(error)}`);
            }
        }
    });
}
