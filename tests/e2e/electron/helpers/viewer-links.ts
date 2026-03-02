import type { Page } from 'puppeteer-core';
import { findVisiblePointInActiveHost } from './viewer-dom';

export async function getLinkOverlayCount(page: Page) {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return host?.querySelectorAll('.pdf-link-overlay-layer .pdf-link-overlay').length ?? 0;
    });
}

export async function installOpenExternalSpy(page: Page) {
    return page.evaluate(() => {
        const electronApi = (window as Window & {
            electronAPI?: {shell?: {openExternal?: (url: string) => Promise<unknown>;};};
            __e2eOpenExternalCalls?: string[];
            __e2eOriginalOpenExternal?: (url: string) => Promise<unknown>;
            __e2eLinkOverlayClickSpyInstalled?: boolean;
        }).electronAPI;

        const root = window as Window & {
            __e2eOpenExternalCalls?: string[];
            __e2eOriginalOpenExternal?: (url: string) => Promise<unknown>;
            __e2eLinkOverlayClickSpyInstalled?: boolean;
        };
        root.__e2eOpenExternalCalls = [];
        const installLinkClickFallback = () => {
            if (root.__e2eLinkOverlayClickSpyInstalled) {
                return true;
            }

            document.addEventListener('click', (event: Event) => {
                const target = event.target as HTMLElement | null;
                const link = target?.closest<HTMLAnchorElement>('.pdf-link-overlay-layer .pdf-link-overlay');
                const href = link?.getAttribute('href');
                if (href) {
                    root.__e2eOpenExternalCalls?.push(String(href));
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    event.stopPropagation();
                }
            }, true);
            root.__e2eLinkOverlayClickSpyInstalled = true;
            return true;
        };

        if (!electronApi?.shell || typeof electronApi.shell.openExternal !== 'function') {
            return installLinkClickFallback();
        }

        const descriptor = Object.getOwnPropertyDescriptor(electronApi.shell, 'openExternal');
        const canOverride = !descriptor || descriptor.writable || descriptor.set || descriptor.configurable;

        if (canOverride) {
            if (!root.__e2eOriginalOpenExternal) {
                root.__e2eOriginalOpenExternal = electronApi.shell.openExternal.bind(electronApi.shell);
            }

            electronApi.shell.openExternal = async (url: string) => {
                root.__e2eOpenExternalCalls?.push(String(url));
                return;
            };
            return true;
        }

        return installLinkClickFallback();
    });
}

export async function clickFirstLinkOverlay(page: Page) {
    const point = await findVisiblePointInActiveHost(page, '.pdf-link-overlay-layer .pdf-link-overlay');
    if (!point) {
        throw new Error('No visible link overlay found');
    }
    await page.mouse.click(point.x, point.y);
}

export async function readOpenExternalCalls(page: Page) {
    return page.evaluate(() => {
        return (window as Window & { __e2eOpenExternalCalls?: string[] }).__e2eOpenExternalCalls ?? [];
    });
}
