import type { BrowserWindow } from 'electron';
import { shell } from 'electron';
import { inspectAllowedExternalUrl } from '@contracts/externalUrl';
import { getErrorMessage } from '@electron/utils/error';

interface ILogger {warn(message: string): void;}

interface ICreateWindowSecurityOptions {
    getTrustedRendererOrigin: () => string;
    logger: ILogger;
}

export function createWindowSecurity(options: ICreateWindowSecurityOptions) {
    function parseUrl(value: string): URL | null {
        try {
            return new URL(value);
        } catch {
            return null;
        }
    }

    function getTrustedServerOrigin() {
        return options.getTrustedRendererOrigin();
    }

    function hasTrustedOrigin(parsed: URL, trustedOrigin: string) {
        const trustedUrl = parseUrl(trustedOrigin);
        if (!trustedUrl) {
            return false;
        }
        if (trustedUrl.protocol === 'evb-viewer:') {
            return parsed.protocol === trustedUrl.protocol
                && parsed.hostname === trustedUrl.hostname;
        }
        return parsed.origin === trustedUrl.origin;
    }

    function isTrustedRendererUrl(value: string) {
        const trustedOrigin = getTrustedServerOrigin();
        if (!trustedOrigin) {
            return false;
        }
        const parsed = parseUrl(value);
        if (!parsed) {
            return false;
        }
        return hasTrustedOrigin(parsed, trustedOrigin);
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
