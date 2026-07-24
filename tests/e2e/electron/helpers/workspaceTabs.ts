import {expect} from 'vitest';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type {IE2EWindow} from '@tests/e2e/electron/helpers/e2EWindow';
import {waitForTabCount} from '@tests/e2e/electron/helpers/waitForTabCount';

export async function createNewWorkspaceTab(session: IElectronE2ESession) {
    const nextCount = await session.page.$$eval('.tab-list .tab[data-tab-id]', tabs => tabs.length + 1);
    const clicked = await session.page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.tab-list .tab-new');
        button?.click();
        return Boolean(button);
    });
    expect(clicked).toBe(true);
    await waitForTabCount(session.page, nextCount);
}

export async function activateWorkspaceTab(session: IElectronE2ESession, tabIndex: number) {
    await session.page.evaluate((index: number) => {
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        tabs[index]?.click();
    }, tabIndex);
}

export async function splitActiveWorkspaceDocument(session: IElectronE2ESession, direction: 'right' | 'down') {
    const split = await session.page.evaluate(async (targetDirection: 'right' | 'down') => {
        const splitEditor = (window as IE2EWindow & {__splitEditorForE2E?: (direction: 'right' | 'down') => Promise<void> | void;}).__splitEditorForE2E;
        if (typeof splitEditor === 'function') {
            await splitEditor(targetDirection);
            return true;
        }
        return false;
    }, direction);
    expect(split).toBe(true);
    await session.page.waitForFunction(() => document.querySelectorAll('.editor-pane').length >= 2);
}
