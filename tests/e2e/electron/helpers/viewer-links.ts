import type { Page } from 'puppeteer-core';
import { waitForActiveWorkspaceHost } from './viewer-dom';

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
    const clicked = await page.evaluate(() => {
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
            overlay.dispatchEvent(new PointerEvent('pointerdown', {
                bubbles: true,
                composed: true,
                clientX: rect.left + (rect.width / 2),
                clientY: rect.top + (rect.height / 2),
                pointerId: 1,
                pointerType: 'mouse',
                button: 0,
                buttons: 1,
            }));
            overlay.click();
            return true;
        }

        return false;
    });
    if (!clicked) {
        throw new Error('No visible link overlay found');
    }
}

export async function readOpenExternalCalls(page: Page) {
    return page.evaluate(() => {
        return (window as Window & { __e2eOpenExternalCalls?: string[] }).__e2eOpenExternalCalls ?? [];
    });
}
