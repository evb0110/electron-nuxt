import type { Page } from 'puppeteer-core';
import { delay } from 'es-toolkit/promise';
import { DEFAULT_TIMEOUT_MS } from './viewer-dom';

export interface ITabSnapshot {
    id: string;
    label: string;
    isActive: boolean;
}

export async function getTabSnapshots(page: Page): Promise<ITabSnapshot[]> {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]')).map((tab) => ({
            id: tab.dataset.tabId ?? '',
            label: (tab.querySelector('.tab-label')?.textContent ?? '').trim(),
            isActive: tab.classList.contains('is-active') || tab.getAttribute('aria-selected') === 'true',
        }));
    });
}

export async function getTabLabels(page: Page): Promise<string[]> {
    const tabs = await getTabSnapshots(page);
    return tabs.map(tab => tab.label).filter(label => label.length > 0);
}

export async function waitForTabCount(page: Page, minCount: number, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction((expected: number) => {
        return document.querySelectorAll('.tab-list .tab[data-tab-id]').length >= expected;
    }, { timeout: timeoutMs }, minCount);
}

export async function waitForTabLabel(page: Page, label: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const labels = await getTabLabels(page);
        if (labels.some(candidate => candidate === label)) {
            return;
        }
        await delay(120);
    }
    throw new Error(`Timed out waiting for tab label '${label}'`);
}
