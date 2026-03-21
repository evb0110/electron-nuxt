import type { BrowserWindow } from 'electron';
import { shell } from 'electron';
import { normalizeAllowedExternalUrl } from '@contracts/external-url';

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
        const sanitizedUrl = normalizeAllowedExternalUrl(url);
        if (!sanitizedUrl) {
            options.logger.warn(`Blocked ${source} URL with unsupported protocol: ${url}`);
            return;
        }
        void shell.openExternal(sanitizedUrl).catch((error) => {
            options.logger.warn(`Failed to open external URL (${source}): ${error instanceof Error ? error.message : String(error)}`);
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
