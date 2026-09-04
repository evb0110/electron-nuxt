import { createHash } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { evaluateInPage } from '@tests/e2e/electron/helpers/pageRuntime';
import { getWorkspaceToolbarSnapshot } from '@tests/e2e/electron/helpers/workspaceExpose';
import { waitForViewerInteractive } from '@tests/e2e/electron/helpers/viewerCore';
import type { IStressAppState } from '@scripts/stress/stressTypes';

interface IDomState {
    tabIds: string[];
    activeTabId: string | null;
    activeTabLabel: string | null;
    visibleDialogs: string[];
    visibleToasts: string[];
}

const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open], .modal';
const TOAST_SELECTOR = '[role="alert"], [role="status"], .toast';

function readDomState(page: Page) {
    return evaluateInPage(page, (dialogSelector: string, toastSelector: string): IDomState => {
        const isVisible = (element: Element) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        };
        const label = (element: Element) => {
            const text = (element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/gu, ' ').trim();
            return text.slice(0, 160);
        };
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.tab-list .tab[data-tab-id]'));
        const activeTab = tabs.find(tab => tab.classList.contains('is-active')) ?? null;
        return {
            tabIds: tabs.map(tab => tab.dataset.tabId ?? ''),
            activeTabId: activeTab?.dataset.tabId ?? null,
            activeTabLabel: activeTab ? label(activeTab) : null,
            visibleDialogs: Array.from(document.querySelectorAll(dialogSelector)).filter(isVisible).map(label),
            visibleToasts: Array.from(document.querySelectorAll(toastSelector)).filter(isVisible).map(label).filter(text => text.length > 0),
        };
    }, DIALOG_SELECTOR, TOAST_SELECTOR);
}

async function probeViewerInteractionReady(page: Page) {
    try {
        await waitForViewerInteractive(page, 250);
        return true;
    } catch {
        return false;
    }
}

/**
 * Structured state for the operator's `app_state` tool and for replay
 * divergence checks. Screenshots are never compared byte-for-byte; this
 * record is what replay hashes instead.
 */
export async function collectStressAppState(page: Page): Promise<IStressAppState> {
    const [
        dom,
        toolbar,
        viewerInteractionReady,
    ] = await Promise.all([
        readDomState(page),
        getWorkspaceToolbarSnapshot(page).catch(() => null),
        probeViewerInteractionReady(page),
    ]);
    const hasDocument = toolbar?.hasPdf ?? false;
    const busy = [
        toolbar?.isOpeningDocument,
        toolbar?.isAnySaving,
        toolbar?.isHistoryBusy,
        toolbar?.isPageOperationInProgress,
    ].some(flag => flag === true);
    return {
        tabIds: dom.tabIds,
        activeTabId: dom.activeTabId,
        fileName: dom.activeTabLabel,
        currentPage: toolbar?.currentPage ?? null,
        totalPages: toolbar?.totalPages ?? null,
        zoomPercent: toolbar ? Math.round(toolbar.effectiveZoom * 100) : null,
        viewMode: toolbar?.viewMode ?? null,
        activeTool: toolbar?.isPlacingPageNote ? 'page-note' : toolbar?.dragMode ? 'drag' : toolbar?.isCapturingRegion ? 'capture-region' : null,
        isDirty: toolbar?.canSave ?? false,
        isOpeningDocument: toolbar?.isOpeningDocument ?? false,
        hasOpenError: toolbar?.hasOpenError ?? false,
        readiness: !hasDocument ? 'no-document' : busy ? 'busy' : 'ready',
        viewerInteractionReady,
        visibleDialogs: dom.visibleDialogs,
        visibleToasts: dom.visibleToasts,
    };
}

/** Stable hash over the fields that describe document state, ignoring transient toasts. */
export function hashStressAppState(state: IStressAppState) {
    const canonical = JSON.stringify({
        tabCount: state.tabIds.length,
        activeTabIndex: state.tabIds.indexOf(state.activeTabId ?? ''),
        fileName: state.fileName,
        currentPage: state.currentPage,
        totalPages: state.totalPages,
        zoomPercent: state.zoomPercent,
        viewMode: state.viewMode,
        activeTool: state.activeTool,
        isDirty: state.isDirty,
        hasOpenError: state.hasOpenError,
        readiness: state.readiness,
        dialogs: state.visibleDialogs,
    });
    return createHash('sha256').update(canonical).digest('hex');
}

export function formatStressAppStateForModel(state: IStressAppState) {
    const lines = [
        `document: ${state.fileName ?? '(none)'}`,
        `page: ${state.currentPage ?? '-'} of ${state.totalPages ?? '-'}`,
        `zoom: ${state.zoomPercent === null ? '-' : `${state.zoomPercent}%`}`,
        `view mode: ${state.viewMode ?? '-'}`,
        `active tool: ${state.activeTool ?? 'none'}`,
        `tabs: ${state.tabIds.length} (active index ${state.tabIds.indexOf(state.activeTabId ?? '')})`,
        `unsaved changes: ${state.isDirty ? 'yes' : 'no'}`,
        `readiness: ${state.readiness}${state.isOpeningDocument ? ' (opening)' : ''}${state.hasOpenError ? ' (open error shown)' : ''}`,
        `viewer interactive: ${state.viewerInteractionReady ? 'yes' : 'no'}`,
    ];
    if (state.visibleDialogs.length > 0) {
        lines.push(`dialogs: ${state.visibleDialogs.join(' | ')}`);
    }
    if (state.visibleToasts.length > 0) {
        lines.push(`messages: ${state.visibleToasts.join(' | ')}`);
    }
    return lines.join('\n');
}
