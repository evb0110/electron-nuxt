import type { Page } from 'puppeteer-core';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface IPoint {
    x: number;
    y: number;
}

export async function findVisiblePointInActiveHost(page: Page, selector: string, text?: string): Promise<IPoint | null> {
    return page.evaluate(({
        targetSelector,
        targetText,
    }) => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 100
                    && rect.height > 100
                );
            }) as HTMLElement | undefined;
        if (!host) {
            return null;
        }

        const nodes = Array.from(host.querySelectorAll<HTMLElement>(targetSelector))
            .filter((node) => {
                const rect = node.getBoundingClientRect();
                const style = window.getComputedStyle(node);
                if (rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || '1') === 0) {
                    return false;
                }
                if (!targetText) {
                    return true;
                }
                return (node.textContent ?? '').trim() === targetText;
            });

        const target = nodes[0];
        if (!target) {
            return null;
        }

        const rect = target.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    }, {
        targetSelector: selector,
        targetText: text ?? null,
    });
}

export async function getRenderedPageCount(page: Page): Promise<number> {
    return page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('.workspace-host'))
            .find((candidate) => {
                const element = candidate as HTMLElement;
                const rect = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);
                return style.display !== 'none' && rect.width > 100 && rect.height > 100;
            }) as HTMLElement | undefined;
        return host?.querySelectorAll('.page_container canvas').length ?? 0;
    });
}
