import type { TSplitPayload } from '@contracts/window-tabs';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';

export async function cleanupSplitPayloadSnapshot(
    payload: TSplitPayload | null | undefined,
    options: {
        logSection: string;
        context: string;
        metadata?: Record<string, unknown>;
    },
) {
    if (!payload || payload.kind !== 'pdfSnapshot') {
        return false;
    }

    try {
        await getElectronAPI().documents.cleanupFile(payload.snapshotPath);
        return true;
    } catch (error) {
        BrowserLogger.warn(
            options.logSection,
            'Failed to cleanup split payload snapshot',
            {
                context: options.context,
                snapshotPath: payload.snapshotPath,
                ...options.metadata,
                error,
            },
        );
        return false;
    }
}
