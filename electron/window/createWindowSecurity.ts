import type { ILogger } from '@electron/utils/createLogger';
import type { BrowserWindow } from 'electron';
import { shell } from 'electron';
import { inspectAllowedExternalUrl } from '@contracts/externalUrl';
import { getErrorMessage } from '@electron/utils/error';
import { isTrustedRendererUrl as matchesTrustedRendererUrl } from '@electron/security/isTrustedRendererUrl';

interface ICreateWindowSecurityOptions {
    getTrustedRendererUrl: () => string;
    logger: ILogger;
}

const EXTERNAL_OPEN_MIN_INTERVAL_MS = 1_000;

export function createWindowSecurity(options: ICreateWindowSecurityOptions) {
    const lastExternalOpenBySource = new Map<string, number>();

    function isTrustedRendererUrl(value: string) {
        return matchesTrustedRendererUrl(value, options.getTrustedRendererUrl());
    }

    function openExternalSafely(url: string, source: 'window-open' | 'navigation') {
        const decision = inspectAllowedExternalUrl(url);
        if (!decision.ok) {
            if (decision.reason === 'unsupported-protocol') {
                options.logger.warn(`Blocked ${source} URL with unsupported protocol: ${url}`);
                return;
            }

            options.logger.warn(`Blocked ${source} URL with invalid value: ${url}`);
            return;
        }
        const rateLimitKey = `${source}:${decision.normalizedUrl}`;
        const now = Date.now();
        const lastOpenedAt = lastExternalOpenBySource.get(rateLimitKey) ?? 0;
        if (now - lastOpenedAt < EXTERNAL_OPEN_MIN_INTERVAL_MS) {
            options.logger.warn(`Blocked repeated ${source} URL open: ${decision.normalizedUrl}`);
            return;
        }
        lastExternalOpenBySource.set(rateLimitKey, now);
        void shell.openExternal(decision.normalizedUrl).catch((error) => {
            options.logger.warn(`Failed to open external URL (${source}): ${getErrorMessage(error)}`);
        });
    }

    function hardenWindowWebContents(window: BrowserWindow) {
        window.webContents.setWindowOpenHandler(({ url }) => {
            openExternalSafely(url, 'window-open');
            return { action: 'deny' };
        });

        window.webContents.on('will-navigate', (event, url) => {
            if (isTrustedRendererUrl(url) || url === 'about:blank') {
                return;
            }

            event.preventDefault();
            openExternalSafely(url, 'navigation');
        });
    }

    return {
        hardenWindowWebContents,
        isTrustedRendererUrl,
    };
}
