import type { BrowserWindow } from 'electron';
import { shell } from 'electron';

const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
    'http:',
    'https:',
    'mailto:',
]);

interface ILogger {warn(message: string): void;}

interface ICreateWindowSecurityOptions {
    logger: ILogger;
    serverUrl: string;
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
            return new URL(options.serverUrl).origin;
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

    function isAllowedExternalUrl(value: string) {
        const parsed = parseUrl(value);
        if (!parsed) {
            return false;
        }
        return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
    }

    function isRuntimeServerUrl(value: string) {
        return (
            value === options.serverUrl
            || value === `${options.serverUrl}/`
            || value.startsWith(`${options.serverUrl}/`)
        );
    }

    function openExternalSafely(url: string, source: 'window-open' | 'navigation') {
        if (!isAllowedExternalUrl(url)) {
            options.logger.warn(`Blocked ${source} URL with unsupported protocol: ${url}`);
            return;
        }
        void shell.openExternal(url).catch((error) => {
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
