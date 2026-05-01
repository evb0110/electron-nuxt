import type { BrowserWindow } from 'electron';
import { shell } from 'electron';
import { inspectAllowedExternalUrl } from '@contracts/external-url';
import { getErrorMessage } from '@electron/utils/error';

interface ILogger {warn(message: string): void;}

interface ICreateWindowSecurityOptions {
    getServerUrl: () => string;
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
        try {
            return new URL(options.getServerUrl()).origin;
        } catch {
            return '';
        }
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
        return parsed.origin === trustedOrigin;
    }

    function isRuntimeServerUrl(value: string) {
        const serverUrl = options.getServerUrl();
        return (
            value === serverUrl
            || value === `${serverUrl}/`
            || value.startsWith(`${serverUrl}/`)
        );
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
        isRuntimeServerUrl,
    };
}
