import type { Page } from 'puppeteer-core';
import { waitForActiveWorkspaceHost } from './viewerDom';

export async function getLinkOverlayCount(page: Page) {
    await waitForActiveWorkspaceHost(page);

    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 100
                    && rect.height > 100
                );
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.pdf-link-overlay-layer .pdf-link-overlay'));
        const fallbackHost = matchingHosts.length === 1 ? (matchingHosts[0] ?? null) : null;
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector('.pdf-link-overlay-layer .pdf-link-overlay')
        )
            ? activeHost
            : (fallbackHost ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        return host?.querySelectorAll('.pdf-link-overlay-layer .pdf-link-overlay').length ?? 0;
    });
}

export async function installOpenExternalSpy(page: Page) {
    return page.evaluate(() => {
        const electronApi = (window as Window & {
            electronAPI?: {shell?: {openExternal?: (url: string) => Promise<unknown>;};};
            __e2eOpenExternalCalls?: string[];
            __e2eOriginalOpenExternal?: (url: string) => Promise<unknown>;
        }).electronAPI;

        const root = window as Window & {
            __e2eOpenExternalCalls?: string[];
            __e2eOriginalOpenExternal?: (url: string) => Promise<unknown>;
        };
        root.__e2eOpenExternalCalls = [];

        if (!electronApi?.shell || typeof electronApi.shell.openExternal !== 'function') {
            throw new Error('electronAPI.shell.openExternal is not available');
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

        throw new Error('electronAPI.shell.openExternal cannot be spied on');
    });
}

export async function clickFirstLinkOverlay(page: Page) {
    const point = await page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((candidate) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 100
                    && rect.height > 100
                );
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.pdf-link-overlay-layer .pdf-link-overlay'));
        const fallbackHost = matchingHosts.length === 1 ? (matchingHosts[0] ?? null) : null;
        const orderedHosts = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector('.pdf-link-overlay-layer .pdf-link-overlay')
        )
            ? [activeHost]
            : (fallbackHost ? [fallbackHost] : []);

        for (const host of orderedHosts) {
            const overlay = Array.from(host.querySelectorAll<HTMLAnchorElement>('.pdf-link-overlay-layer .pdf-link-overlay'))
                .find((candidate) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        rect.width > 2
                        && rect.height > 2
                        && style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && Number(style.opacity || '1') > 0
                    );
                });
            if (!overlay) {
                continue;
            }

            const rect = overlay.getBoundingClientRect();
            return {
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
            };
        }

        return null;
    });
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
