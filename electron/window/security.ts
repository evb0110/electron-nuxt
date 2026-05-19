import type { BrowserWindow } from 'electron';
import { shell } from 'electron';
import { inspectAllowedExternalUrl } from '@contracts/externalUrl';
import { getErrorMessage } from '@electron/utils/error';
import { isTrustedRendererUrl as matchesTrustedRendererUrl } from '@electron/security/trustedRendererUrl';

interface ILogger {warn(message: string): void;}

interface ICreateWindowSecurityOptions {
    getTrustedRendererUrl: () => string;
    logger: ILogger;
}

export function createWindowSecurity(options: ICreateWindowSecurityOptions) {
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
