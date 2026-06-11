import {
    describe,
    expect,
    it,
} from 'vitest';
import { delay } from 'es-toolkit/promise';
import type { Page } from 'puppeteer-core';
import {
    copyProjectFixture,
    createMultiPageTextFixturePdf,
} from '@tests/e2e/electron/helpers/fixtures';
import { createElectronE2ESessionFixture } from '@tests/e2e/electron/helpers/createElectronE2ESessionFixture';
import {
    clickLatestVisibleNoteWindowClose,
    collectStickyNoteDebugState,
    createFreeTextAnnotation,
    createHighlightWithPdfjsManager,
    getFreeTextEditorCount,
    getVisibleHighlightEditorCount,
    waitForHighlightEditorCount,
    waitForNoOpenNoteWindows,
    waitForPdfAnnotationSubtypeCount,
} from '@tests/e2e/electron/helpers/viewerAnnotations';
import {
    openAnnotationsTab,
    openPdfInApp,
    saveViaWindowHandle,
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';
import { waitForActiveWorkspaceHost } from '@tests/e2e/electron/helpers/viewerDom';
import {
    callWorkspaceCommand,
    collectWorkspaceExposeDebugState,
    getWorkspaceToolbarSnapshot,
} from '@tests/e2e/electron/helpers/workspaceExpose';

const NOTE_TEXT_ENTRY_TIMEOUT_MS = 20_000;
const TOOLTIP_HIDDEN_QUIET_WINDOW_MS = 400;
const TOOLTIP_HIDDEN_POLL_INTERVAL_MS = 50;

async function waitForActiveTabDirtyState(page: Page, expectedDirty: boolean) {
    const startedAt = Date.now();
    let actualDirty = await page.evaluate(() => (
        document.querySelector<HTMLElement>('.tab.is-active')?.classList.contains('is-dirty') ?? false
    ));
    while (Date.now() - startedAt < 10_000) {
        if (actualDirty === expectedDirty) {
            return;
        }
        await delay(100);
        actualDirty = await page.evaluate(() => (
            document.querySelector<HTMLElement>('.tab.is-active')?.classList.contains('is-dirty') ?? false
        ));
    }
    throw new Error(`Expected active tab dirty=${expectedDirty}, got ${actualDirty}`);
}

async function clickEnabledToolbarAction(page: Page, label: string) {
    const clickedButton = await page.evaluate((targetLabel: string) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
            .find(candidate => (
                candidate.getAttribute('aria-label')?.trim() === targetLabel
                && isVisible(candidate)
                && !candidate.disabled
                && candidate.getAttribute('aria-disabled') !== 'true'
            ));
        button?.click();
        return Boolean(button);
    }, label);
    if (clickedButton) {
        return;
    }

    const commandName = label === 'Undo'
        ? 'handleUndo'
        : label === 'Redo'
            ? 'handleRedo'
            : null;
    const canRunKey = label === 'Undo'
        ? 'canUndo'
        : label === 'Redo'
            ? 'canRedo'
            : null;
    const toolbarSnapshot = await getWorkspaceToolbarSnapshot(page);
    const commandResult = commandName && canRunKey && toolbarSnapshot?.[canRunKey] === true
        ? await callWorkspaceCommand(page, commandName)
        : { called: false };

    if (!commandResult.called) {
        const buttonState = await page.evaluate((targetLabel: string) => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            return { buttons: Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
                .filter(button => button.getAttribute('aria-label')?.trim() === targetLabel)
                .map(button => ({
                    visible: isVisible(button),
                    disabled: button.disabled,
                    ariaDisabled: button.getAttribute('aria-disabled'),
                    text: button.textContent?.trim() ?? '',
                })) };
        }, label);
        const debugState = {
            ...buttonState,
            toolbarSnapshot,
            workspaceDebug: await collectWorkspaceExposeDebugState(page),
        };
        throw new Error(`Enabled toolbar action not found: ${label}: ${JSON.stringify(debugState)}`);
    }
}

async function clickFirstSidebarAnnotationDelete(page: Page) {
    const result = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 100
                && rect.height > 100
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = (activeHost && isVisible(activeHost))
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const buttons = Array.from(host?.querySelectorAll<HTMLButtonElement>('.pdf-sidebar .note-item-delete') ?? [])
            .filter(button => !button.disabled && button.offsetParent !== null);
        buttons[0]?.click();
        return buttons.length;
    });

    if (result < 1) {
        throw new Error('No visible sidebar annotation delete button found');
    }
}

async function resolvePageNotePoint(page: Page) {
    return page.evaluate(() => {
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter((host) => {
                const rect = host.getBoundingClientRect();
                const style = window.getComputedStyle(host);
                return rect.width > 100 && rect.height > 100 && style.display !== 'none' && style.visibility !== 'hidden';
            });
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && visibleHosts.includes(activeHost)
            ? activeHost
            : (visibleHosts[0] ?? null);
        const pageElement = host?.querySelector<HTMLElement>('.page_container--rendered')
            ?? host?.querySelector<HTMLElement>('.page_container')
            ?? null;
        if (!pageElement) {
            return null;
        }

        const rect = pageElement.getBoundingClientRect();
        const x = Math.min(
            Math.max(rect.left + 24, rect.left + rect.width * 0.72),
            window.innerWidth - 96,
        );
        const y = Math.min(
            Math.max(rect.top + 24, rect.top + rect.height * 0.24),
            window.innerHeight - 96,
        );
        return {
            x,
            y,
        };
    });
}

async function tryCreatePageNoteViaContextMenu(page: Page) {
    const point = await resolvePageNotePoint(page);
    if (!point) {
        return null;
    }

    await page.mouse.click(point.x, point.y, { button: 'right' });
    const created = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(
            '.annotation-context-menu .pdf-context-menu__action',
        ));
        const button = buttons.find(candidate =>
            (candidate.textContent ?? '').trim().toLowerCase() === 'add note here',
        );
        if (!button || button.disabled) {
            return false;
        }
        button.click();
        return true;
    });

    if (!created) {
        return null;
    }

    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch {
        throw new Error(`Context-menu note action did not open a note window: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
    }
    return point;
}

async function tryCreatePageNoteViaSidebarButton(page: Page) {
    const point = await resolvePageNotePoint(page);
    if (!point) {
        return null;
    }

    const started = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const button = Array.from(host?.querySelectorAll<HTMLButtonElement>(
            '.notes-list-header .notes-header-btn',
        ) ?? [])
            .filter(button => !button.disabled && isVisible(button))
            .find((button) => {
                const label = (button.getAttribute('aria-label') ?? '').trim().toLowerCase();
                return label.startsWith('place note') || label.includes('place note on page');
            });
        button?.click();
        return Boolean(button);
    });

    if (!started) {
        return null;
    }

    await page.mouse.click(point.x, point.y);
    try {
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
    } catch {
        return null;
    }
    return point;
}

async function getVisibleSidebarAnnotationCount(page: Page) {
    return page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible)
            .length;
    });
}

async function waitForSidebarAnnotationCount(page: Page, expectedCount: number) {
    await page.waitForFunction((count: number) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const visibleItems = Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible);
        return visibleItems.length === count;
    }, { timeout: 8_000 }, expectedCount);
}

async function waitForSidebarAnnotationText(page: Page, expectedText: string) {
    await page.waitForFunction((text: string) => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisible);
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return Array.from(host?.querySelectorAll<HTMLElement>('.notes-list .note-item') ?? [])
            .filter(isVisible)
            .some(item => item.textContent?.includes(text));
    }, { timeout: 8_000 }, expectedText);
}

async function openThumbnailsTab(page: Page) {
    const result = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const sidebar = host?.querySelector<HTMLElement>('.pdf-sidebar');
        const tabList = sidebar?.querySelector<HTMLElement>('[role="tablist"]') ?? sidebar?.firstElementChild;
        const roleTabs = Array.from(tabList?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])
            .filter(isVisible);
        const tabs = roleTabs.length > 0
            ? roleTabs
            : Array.from(tabList?.querySelectorAll<HTMLElement>('button') ?? [])
                .filter(isVisible);
        const pagesTab = tabs.find(tab => (
            (tab.textContent ?? '').includes('Pages')
            || (tab.getAttribute('aria-label') ?? '').includes('Pages')
            || (tab.getAttribute('title') ?? '').includes('Pages')
        )) ?? tabs[1] ?? null;
        const rect = pagesTab?.getBoundingClientRect();
        return {
            clicked: Boolean(pagesTab),
            clickPoint: rect
                ? {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                }
                : null,
            tabCount: tabs.length,
            tabText: tabs.map(tab => tab.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
        };
    });

    if (!result.clicked || !result.clickPoint) {
        throw new Error(`Could not open thumbnails tab: ${JSON.stringify(result)}`);
    }
    await page.mouse.click(result.clickPoint.x, result.clickPoint.y);

    try {
        await page.waitForFunction(() => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
            const host = activeHost && isVisible(activeHost)
                ? activeHost
                : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
            const thumbnail = host?.querySelector<HTMLElement>('.pdf-sidebar-pages-thumbnails .pdf-thumbnail.is-active');
            const canvas = thumbnail?.querySelector<HTMLCanvasElement>('canvas') ?? null;
            return Boolean(thumbnail && canvas && isVisible(thumbnail) && isVisible(canvas));
        }, { timeout: 8_000 });
    } catch {
        const debug = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.pdf-sidebar'))
            .map((sidebar) => {
                const isVisible = (candidate: HTMLElement) => {
                    const rect = candidate.getBoundingClientRect();
                    const style = window.getComputedStyle(candidate);
                    return (
                        style.display !== 'none'
                        && style.visibility !== 'hidden'
                        && rect.width > 0
                        && rect.height > 0
                    );
                };
                const tabs = Array.from(sidebar.querySelectorAll<HTMLElement>('[role="tab"], button'))
                    .map(tab => ({
                        visible: isVisible(tab),
                        text: tab.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                        aria: tab.getAttribute('aria-label') ?? null,
                        title: tab.getAttribute('title') ?? null,
                        selected: tab.getAttribute('aria-selected') ?? null,
                        state: tab.getAttribute('data-state') ?? null,
                        classes: tab.className,
                    }));
                const pages = sidebar.querySelector<HTMLElement>('.pdf-sidebar-pages');
                const pagesRect = pages?.getBoundingClientRect();
                return {
                    sidebarVisible: isVisible(sidebar),
                    tabs,
                    pagesDisplay: pages ? window.getComputedStyle(pages).display : null,
                    pagesRect: pagesRect
                        ? {
                            width: Math.round(pagesRect.width),
                            height: Math.round(pagesRect.height),
                        }
                        : null,
                };
            }));
        throw new Error(`Could not open visible thumbnails tab: clicked=${JSON.stringify(result)} debug=${JSON.stringify(debug)}`);
    }
}

async function getActiveThumbnailYellowPixelCount(page: Page) {
    return page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const canvas = host?.querySelector<HTMLCanvasElement>(
            '.pdf-sidebar-pages-thumbnails .pdf-thumbnail.is-active canvas',
        ) ?? null;
        if (
            !canvas
            || !isVisible(canvas)
            || canvas.width <= 0
            || canvas.height <= 0
            || canvas.dataset.thumbnailRendered !== 'true'
        ) {
            return null;
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) {
            return null;
        }
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let yellowPixels = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const alpha = pixels[index + 3] ?? 0;
            if (
                alpha > 120
                && red > 190
                && green > 155
                && blue < 205
                && red - blue > 35
                && green - blue > 10
            ) {
                yellowPixels += 1;
            }
        }
        return yellowPixels;
    });
}

async function waitForActiveThumbnailYellowPixelCount(
    page: Page,
    predicate: (count: number) => boolean,
    label: string,
) {
    const startedAt = Date.now();
    let count = await getActiveThumbnailYellowPixelCount(page);
    while (Date.now() - startedAt < 12_000) {
        if (typeof count === 'number' && predicate(count)) {
            return count;
        }
        await delay(200);
        count = await getActiveThumbnailYellowPixelCount(page);
    }
    const debug = await page.evaluate(() => {
        const isVisible = (candidate: HTMLElement) => {
            const rect = candidate.getBoundingClientRect();
            const style = window.getComputedStyle(candidate);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && rect.width > 0
                && rect.height > 0
            );
        };
        const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
        const host = activeHost && isVisible(activeHost)
            ? activeHost
            : Array.from(document.querySelectorAll<HTMLElement>('.workspace-host')).find(isVisible);
        const thumbnails = Array.from(host?.querySelectorAll<HTMLElement>(
            '.pdf-sidebar-pages-thumbnails .pdf-thumbnail',
        ) ?? []);
        return {
            hostVisible: Boolean(host),
            activeTabButton: Array.from(host?.querySelectorAll<HTMLElement>('[role="tab"], button') ?? [])
                .filter(isVisible)
                .map(button => ({
                    text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
                    aria: button.getAttribute('aria-label') ?? null,
                    selected: button.getAttribute('aria-selected') ?? null,
                    state: button.getAttribute('data-state') ?? null,
                }))
                .slice(0, 8),
            thumbnails: thumbnails.map((thumbnail) => {
                const rect = thumbnail.getBoundingClientRect();
                const canvas = thumbnail.querySelector<HTMLCanvasElement>('canvas');
                return {
                    page: thumbnail.dataset.page ?? null,
                    active: thumbnail.classList.contains('is-active'),
                    visible: isVisible(thumbnail),
                    rect: {
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                    },
                    canvasWidth: canvas?.width ?? null,
                    canvasHeight: canvas?.height ?? null,
                    rendered: canvas?.dataset.thumbnailRendered ?? null,
                    renderKey: canvas?.dataset.thumbnailRenderKey ?? null,
                };
            }),
        };
    });
    throw new Error(`Timed out waiting for thumbnail yellow pixels (${label}); last count=${count}; debug=${JSON.stringify(debug)}`);
}

async function placeEmptyNote(page: Page) {
    const contextMenuPoint = await tryCreatePageNoteViaContextMenu(page);
    if (contextMenuPoint) {
        return;
    }

    const sidebarPoint = await tryCreatePageNoteViaSidebarButton(page);
    if (sidebarPoint) {
        return;
    }

    throw new Error(`Could not create sticky note through visible controls: ${JSON.stringify(await collectStickyNoteDebugState(page))}`);
}

async function getCommentMarkerAnchorState(page: Page) {
    await waitForActiveWorkspaceHost(page);
    return page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll<HTMLElement>('.freeTextEditor.pdf-comment-marker-anchor-editor'));
        return anchors.map((anchor) => {
            const computed = window.getComputedStyle(anchor);
            return {
                dataAnchor: anchor.getAttribute('data-evb-comment-marker-anchor'),
                ariaHidden: anchor.getAttribute('aria-hidden'),
                inlineLeft: anchor.style.left,
                inlineTop: anchor.style.top,
                inlineWidth: anchor.style.width,
                inlineHeight: anchor.style.height,
                opacity: computed.opacity,
                pointerEvents: computed.pointerEvents,
                borderTopStyle: computed.borderTopStyle,
                borderTopColor: computed.borderTopColor,
                outlineStyle: computed.outlineStyle,
                boxShadow: computed.boxShadow,
            };
        });
    });
}

async function getCommentMarkerAnchorDebugState(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host')
            ?? document.querySelector<HTMLElement>('.workspace-host');
        const readEditor = (editor: HTMLElement) => {
            const computed = window.getComputedStyle(editor);
            const rect = editor.getBoundingClientRect();
            return {
                className: editor.className,
                dataAnchor: editor.getAttribute('data-evb-comment-marker-anchor'),
                ariaHidden: editor.getAttribute('aria-hidden'),
                inlineLeft: editor.style.left,
                inlineTop: editor.style.top,
                inlineWidth: editor.style.width,
                inlineHeight: editor.style.height,
                opacity: computed.opacity,
                pointerEvents: computed.pointerEvents,
                rect: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                },
            };
        };
        return {
            hostFound: Boolean(host),
            hostClassName: host?.className ?? null,
            markerCount: host?.querySelectorAll('.pdf-comment-marker-button').length ?? 0,
            globalMarkerCount: document.querySelectorAll('.pdf-comment-marker-button').length,
            freeTextEditors: Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []).map(readEditor),
            globalFreeTextEditors: Array.from(document.querySelectorAll<HTMLElement>('.freeTextEditor')).map(readEditor),
        };
    });
}

async function waitForCommentMarkerAnchorState(page: Page) {
    try {
        await page.waitForFunction(() => {
            const anchor = document.querySelector<HTMLElement>('.freeTextEditor.pdf-comment-marker-anchor-editor');
            if (!anchor) {
                return false;
            }
            const computed = window.getComputedStyle(anchor);
            return anchor.getAttribute('data-evb-comment-marker-anchor') === 'true'
                && computed.opacity === '0'
                && computed.pointerEvents === 'none';
        }, { timeout: 8_000 });
    } catch (error) {
        throw new Error(`Timed out waiting for hidden sticky-note anchor: ${JSON.stringify(await getCommentMarkerAnchorDebugState(page))}`, { cause: error });
    }

    const state = await getCommentMarkerAnchorState(page);
    if (state.length === 0) {
        throw new Error('Expected a PDF.js FreeText sticky-note anchor');
    }
    return state[0]!;
}

async function getLatestCommentMarkerKey(page: Page) {
    await page.waitForFunction(() => document.querySelectorAll('.pdf-comment-marker-button').length > 0, { timeout: 8_000 });
    return page.evaluate(() => {
        const markers = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'));
        return markers.at(-1)?.dataset.stableKey ?? null;
    });
}

async function getCommentMarkerCenter(page: Page, stableKey: string) {
    const center = await page.evaluate((targetKey: string) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey);
        if (!marker) {
            return null;
        }
        const rect = marker.getBoundingClientRect();
        return {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
        };
    }, stableKey);
    if (!center) {
        throw new Error(`Could not locate marker ${stableKey}: ${JSON.stringify(await getCommentMarkerAnchorDebugState(page))}`);
    }
    return center;
}

async function movePointerAwayFromCommentMarker(
    page: Page,
    stableKey: string,
    center: {
        x: number;
        y: number;
    },
) {
    const awayPoint = {
        x: Math.max(8, center.x - 120),
        y: Math.max(8, center.y - 120),
    };
    await page.mouse.move(awayPoint.x, awayPoint.y, { steps: 8 });
    await page.evaluate(({
        targetKey,
        x,
        y,
    }: {
        targetKey: string;
        x: number;
        y: number;
    }) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey);
        marker?.dispatchEvent(new PointerEvent('pointerleave', {
            bubbles: false,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: 'mouse',
        }));
    }, {
        targetKey: stableKey,
        ...awayPoint,
    });
}

async function movePointerOverCommentMarker(
    page: Page,
    stableKey: string,
    center: {
        x: number;
        y: number;
    },
) {
    await page.mouse.move(center.x, center.y, { steps: 8 });
    await page.evaluate(({
        targetKey,
        x,
        y,
    }: {
        targetKey: string;
        x: number;
        y: number;
    }) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey);
        marker?.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: 1,
            pointerType: 'mouse',
        }));
    }, {
        targetKey: stableKey,
        ...center,
    });
}

async function waitForVisibleTooltipText(page: Page, expectedText: string) {
    try {
        await page.waitForFunction((text: string) => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="content"]'))
                .filter(isVisible)
                .some(tooltip => tooltip.textContent?.includes(text));
        }, { timeout: 8_000 }, expectedText);
    } catch (error) {
        throw new Error(`Timed out waiting for visible tooltip text: ${JSON.stringify(await collectTooltipDebugState(page))}`, { cause: error });
    }
}

async function waitForNoVisibleTooltipText(page: Page, expectedText: string) {
    try {
        await page.waitForFunction((text: string) => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            return !Array.from(document.querySelectorAll<HTMLElement>('[data-slot="content"]'))
                .filter(isVisible)
                .some(tooltip => tooltip.textContent?.includes(text));
        }, { timeout: 4_000 }, expectedText);
    } catch (error) {
        throw new Error(`Timed out waiting for tooltip text to disappear: ${JSON.stringify(await collectTooltipDebugState(page))}`, { cause: error });
    }
}

async function waitForTooltipTextToRemainHidden(page: Page, expectedText: string, timeoutMs = 4_000) {
    const startedAt = Date.now();
    let hiddenSince: number | null = null;

    while (Date.now() - startedAt < timeoutMs) {
        const hasVisibleTooltip = await page.evaluate((text: string) => {
            const isVisible = (candidate: HTMLElement) => {
                const rect = candidate.getBoundingClientRect();
                const style = window.getComputedStyle(candidate);
                return (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0
                );
            };
            return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="content"]'))
                .filter(isVisible)
                .some(tooltip => tooltip.textContent?.includes(text));
        }, expectedText);

        if (hasVisibleTooltip) {
            hiddenSince = null;
        } else {
            hiddenSince ??= Date.now();
            if (Date.now() - hiddenSince >= TOOLTIP_HIDDEN_QUIET_WINDOW_MS) {
                return;
            }
        }

        await delay(TOOLTIP_HIDDEN_POLL_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for tooltip text to remain hidden: ${JSON.stringify(await collectTooltipDebugState(page))}`);
}

async function collectTooltipDebugState(page: Page) {
    return page.evaluate(() => {
        const readElement = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return {
                className: String(element.className),
                dataSlot: element.dataset.slot ?? null,
                dataStableKey: element.dataset.stableKey ?? null,
                role: element.getAttribute('role'),
                text: (element.textContent?.replace(/\s+/g, ' ').trim() ?? '').slice(0, 180),
                visible: (
                    style.display !== 'none'
                    && style.visibility !== 'hidden'
                    && Number(style.opacity || '1') > 0
                    && rect.width > 0
                    && rect.height > 0
                ),
                rect: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top),
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                },
            };
        };
        const markers = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'));
        return {
            activeElement: document.activeElement instanceof HTMLElement
                ? {
                    tagName: document.activeElement.tagName.toLowerCase(),
                    className: String(document.activeElement.className),
                }
                : null,
            markers: markers.map((marker) => {
                const markerState = readElement(marker);
                const rect = marker.getBoundingClientRect();
                const centerX = Math.round(rect.left + rect.width / 2);
                const centerY = Math.round(rect.top + rect.height / 2);
                const elementAtCenter = document.elementFromPoint(centerX, centerY);
                return {
                    ...markerState,
                    ariaLabel: marker.getAttribute('aria-label'),
                    parentClassName: String(marker.parentElement?.className ?? ''),
                    parentIsTooltipTrigger: marker.parentElement?.classList.contains('app-tooltip-trigger') ?? false,
                    elementAtCenter: elementAtCenter instanceof HTMLElement
                        ? {
                            tagName: elementAtCenter.tagName.toLowerCase(),
                            className: String(elementAtCenter.className),
                            dataStableKey: elementAtCenter.dataset.stableKey ?? null,
                        }
                        : null,
                };
            }),
            tooltipContents: Array.from(document.querySelectorAll<HTMLElement>('[data-slot="content"], [role="tooltip"]'))
                .map(readElement),
        };
    });
}

async function clickCommentMarker(page: Page, stableKey: string) {
    const clicked = await page.evaluate((targetKey: string) => {
        const marker = Array.from(document.querySelectorAll<HTMLButtonElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey);
        marker?.click();
        return Boolean(marker);
    }, stableKey);
    if (!clicked) {
        throw new Error(`Could not click marker ${stableKey}: ${JSON.stringify(await collectTooltipDebugState(page))}`);
    }
}

async function dragCommentMarker(page: Page, stableKey: string, dx: number, dy: number) {
    const readDebugState = async () => page.evaluate((targetKey: string) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey) ?? null;
        const markerRect = marker?.getBoundingClientRect() ?? null;
        const center = markerRect
            ? {
                x: Math.round(markerRect.x + markerRect.width / 2),
                y: Math.round(markerRect.y + markerRect.height / 2),
            }
            : null;
        const elementAtCenter = center
            ? document.elementFromPoint(center.x, center.y) as HTMLElement | null
            : null;
        return {
            markerCount: document.querySelectorAll('.pdf-comment-marker-button').length,
            markerClassName: marker?.className ?? null,
            markerStyle: marker?.getAttribute('style') ?? null,
            markerRect: markerRect
                ? {
                    left: Math.round(markerRect.left),
                    top: Math.round(markerRect.top),
                    width: Math.round(markerRect.width),
                    height: Math.round(markerRect.height),
                }
                : null,
            elementAtCenter: elementAtCenter
                ? {
                    tag: elementAtCenter.tagName.toLowerCase(),
                    className: elementAtCenter.className,
                    aria: elementAtCenter.getAttribute('aria-label'),
                    dataStableKey: elementAtCenter.dataset.stableKey ?? null,
                }
                : null,
        };
    }, stableKey);

    const startPoint = await page.evaluate((targetKey: string) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey);
        if (!marker) {
            return null;
        }
        const rect = marker.getBoundingClientRect();
        return {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
        };
    }, stableKey);
    if (!startPoint) {
        throw new Error(`Could not locate marker ${stableKey}`);
    }

    const dispatched = await page.evaluate(({
        deltaX,
        deltaY,
        targetKey,
    }) => {
        const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
            .find(candidate => candidate.dataset.stableKey === targetKey);
        if (!marker) {
            return false;
        }
        const rect = marker.getBoundingClientRect();
        const startX = Math.round(rect.x + rect.width / 2);
        const startY = Math.round(rect.y + rect.height / 2);
        const pointerId = 1;
        marker.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            clientX: startX,
            clientY: startY,
            isPrimary: true,
            pointerId,
            pointerType: 'mouse',
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
            clientX: startX + deltaX,
            clientY: startY + deltaY,
            isPrimary: true,
            pointerId,
            pointerType: 'mouse',
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 0,
            clientX: startX + deltaX,
            clientY: startY + deltaY,
            isPrimary: true,
            pointerId,
            pointerType: 'mouse',
        }));
        return true;
    }, {
        deltaX: dx,
        deltaY: dy,
        targetKey: stableKey,
    });
    if (!dispatched) {
        throw new Error(`Could not dispatch marker drag: ${JSON.stringify(await readDebugState())}`);
    }

    try {
        await page.waitForFunction(({
            startX,
            startY,
            targetKey,
        }) => {
            const marker = Array.from(document.querySelectorAll<HTMLElement>('.pdf-comment-marker-button'))
                .find(candidate => candidate.dataset.stableKey === targetKey);
            if (!marker) {
                return false;
            }
            const rect = marker.getBoundingClientRect();
            const centerX = rect.x + rect.width / 2;
            const centerY = rect.y + rect.height / 2;
            return Math.hypot(centerX - startX, centerY - startY) >= 12;
        }, { timeout: 8_000 }, {
            startX: startPoint.x,
            startY: startPoint.y,
            targetKey: stableKey,
        });
    } catch (error) {
        throw new Error(`Marker did not move after drag: ${JSON.stringify({
            before: startPoint,
            after: await readDebugState(),
            anchor: await getCommentMarkerAnchorDebugState(page),
        })}`, { cause: error });
    }
}

async function setLatestNoteWindowText(page: Page, text: string) {
    await page.evaluate((noteText: string) => {
        const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea.note-window__textarea'));
        const textarea = textareas.at(-1) ?? null;
        if (!textarea) {
            throw new Error('No note window textarea found');
        }
        const setter = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            'value',
        )?.set;
        setter?.call(textarea, noteText);
        textarea.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: noteText,
            inputType: 'insertText',
        }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, text);
}

describe('Electron E2E - Annotation Lifecycle', () => {
    const sessionFixture = createElectronE2ESessionFixture({sessionName: () => `e2e-annotation-lifecycle-${Date.now()}`});

    it('creates and edits a FreeText annotation in the active workspace', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const fixturePath = copyProjectFixture('freetext-lifecycle-test.pdf', `annotation-lifecycle-${Date.now()}-freetext.pdf`);
        await openPdfInApp(page, fixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getFreeTextEditorCount(page);
        const typedText = `Annotation lifecycle free text ${Date.now()}`;
        const createdCount = await createFreeTextAnnotation(page, typedText);
        expect(createdCount).toBeGreaterThan(baselineCount);

        await waitForActiveWorkspaceHost(page);
        const latestTextHandle = await page.waitForFunction((expectedText: string) => {
            const activeHost = document.querySelector<HTMLElement>('.editor-pane.is-active .workspace-host');
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
            const host = (activeHost && visibleHosts.includes(activeHost))
                ? activeHost
                : (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const matchingText = editors
                .map((editor) => (editor.querySelector<HTMLElement>('[contenteditable], .internal') ?? editor).textContent ?? '')
                .map(text => text.replace(/\u200B/g, '').trim())
                .find(text => text.includes(expectedText));
            return matchingText ?? false;
        }, { timeout: 8_000 }, typedText);
        const latestText = await latestTextHandle.jsonValue();
        expect(latestText).toContain(typedText);
    });

    it('shows a placed empty sticky note in the sidebar before text is entered', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-sticky-sidebar.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineCount = await getVisibleSidebarAnnotationCount(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);

        const noteText = `Sticky sidebar text ${Date.now()}`;
        await setLatestNoteWindowText(page, noteText);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);
        await waitForSidebarAnnotationText(page, noteText);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationCount(page, baselineCount);
    });

    it('dismisses the marker tooltip when opening the sticky note window', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-sticky-tooltip-dismiss.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineCount = await getVisibleSidebarAnnotationCount(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);

        const noteText = `Sticky tooltip ${Date.now()}`;
        await setLatestNoteWindowText(page, noteText);
        await waitForSidebarAnnotationText(page, noteText);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);

        const markerKey = await getLatestCommentMarkerKey(page);
        if (!markerKey) {
            throw new Error(`Expected a visible sticky-note marker: ${JSON.stringify(await getCommentMarkerAnchorDebugState(page))}`);
        }
        const markerCenter = await getCommentMarkerCenter(page, markerKey);

        await movePointerAwayFromCommentMarker(page, markerKey, markerCenter);
        await waitForNoVisibleTooltipText(page, noteText);
        await movePointerOverCommentMarker(page, markerKey, markerCenter);
        await waitForVisibleTooltipText(page, noteText);

        await clickCommentMarker(page, markerKey);
        await page.waitForSelector('textarea.note-window__textarea', { timeout: NOTE_TEXT_ENTRY_TIMEOUT_MS });
        await movePointerOverCommentMarker(page, markerKey, markerCenter);
        await waitForTooltipTextToRemainHidden(page, noteText);
        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);
    });

    it('keeps the unsaved sticky note PDF.js anchor hidden and synced while dragging its marker', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-sticky-anchor-drag.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineCount = await getVisibleSidebarAnnotationCount(page);
        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineCount + 1);

        const beforeAnchor = await waitForCommentMarkerAnchorState(page);
        expect(beforeAnchor.dataAnchor).toBe('true');
        expect(beforeAnchor.ariaHidden).toBe('true');
        expect(beforeAnchor.opacity).toBe('0');
        expect(beforeAnchor.pointerEvents).toBe('none');
        expect(beforeAnchor.inlineLeft).toMatch(/%$/);
        expect(beforeAnchor.inlineTop).toMatch(/%$/);

        await clickLatestVisibleNoteWindowClose(page);
        await waitForNoOpenNoteWindows(page);

        const markerKey = await getLatestCommentMarkerKey(page);
        if (!markerKey) {
            throw new Error(`Expected a visible sticky-note marker: ${JSON.stringify(await getCommentMarkerAnchorDebugState(page))}`);
        }

        await dragCommentMarker(page, markerKey, 130, 70);

        await page.waitForFunction((previous: {
            left: string;
            top: string;
        }) => {
            const anchor = document.querySelector<HTMLElement>('.freeTextEditor.pdf-comment-marker-anchor-editor');
            if (!anchor) {
                return false;
            }
            const computed = window.getComputedStyle(anchor);
            return computed.opacity === '0'
                && computed.pointerEvents === 'none'
                && (
                    anchor.style.left !== previous.left
                    || anchor.style.top !== previous.top
                );
        }, { timeout: 8_000 }, {
            left: beforeAnchor.inlineLeft,
            top: beforeAnchor.inlineTop,
        });

        const afterAnchor = await waitForCommentMarkerAnchorState(page);
        expect(afterAnchor.inlineLeft).not.toBe(beforeAnchor.inlineLeft);
        expect(afterAnchor.inlineTop).not.toBe(beforeAnchor.inlineTop);
        expect(afterAnchor.opacity).toBe('0');
        expect(afterAnchor.pointerEvents).toBe('none');
        expect(afterAnchor.outlineStyle === 'none' || afterAnchor.outlineStyle === '').toBe(true);
        expect(afterAnchor.boxShadow).toBe('none');
    });

    it('undoes a sticky note created after a highlight without removing the highlight', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const noteFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-highlight-then-note-undo.pdf`,
            1,
        );
        await openPdfInApp(page, noteFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForViewerInteractive(page);

        const baselineHighlightCount = await getVisibleHighlightEditorCount(page);
        const baselineSidebarCount = await getVisibleSidebarAnnotationCount(page);
        await createHighlightWithPdfjsManager(page);
        await waitForHighlightEditorCount(page, baselineHighlightCount + 1);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);

        await placeEmptyNote(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 2);

        await clickEnabledToolbarAction(page, 'Undo');

        await waitForNoOpenNoteWindows(page);
        await waitForSidebarAnnotationCount(page, baselineSidebarCount + 1);
        await waitForHighlightEditorCount(page, baselineHighlightCount + 1);
    });

    it('keeps highlight undo and redo coherent after saving', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-highlight.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        const createdCount = await createHighlightWithPdfjsManager(page);
        expect(createdCount).toBeGreaterThan(baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count > 80,
            'live highlight visible before save',
        );
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count < 20,
            'undone live highlight hidden before save',
        );
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        const deletedSummary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 0);
        expect(deletedSummary.bySubtype.Highlight ?? 0).toBe(0);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Redo');
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        const summary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        expect(summary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
    });

    it('restores a persisted highlight when undoing a saved sidebar delete', async () => {
        const session = sessionFixture.getSession();
        if (!session) {
            return;
        }
        const { page } = session;

        const highlightFixturePath = await createMultiPageTextFixturePdf(
            `annotation-lifecycle-${Date.now()}-persisted-highlight-delete.pdf`,
            1,
        );
        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);

        const baselineCount = await getVisibleHighlightEditorCount(page);
        await createHighlightWithPdfjsManager(page);
        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        await waitForActiveTabDirtyState(page, false);

        await openPdfInApp(page, highlightFixturePath);
        await waitForPdfLoaded(page);
        await openAnnotationsTab(page);
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await openThumbnailsTab(page);
        const highlightedThumbnailYellowCount = await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count > 80,
            'persisted highlight visible in thumbnail',
        );
        await openAnnotationsTab(page);

        await clickFirstSidebarAnnotationDelete(page);
        await waitForHighlightEditorCount(page, baselineCount);
        await waitForActiveTabDirtyState(page, true);
        await openThumbnailsTab(page);
        const deletedThumbnailYellowCount = await waitForActiveThumbnailYellowPixelCount(
            page,
            count => count <= Math.max(20, Math.floor(highlightedThumbnailYellowCount * 0.25)),
            'deleted persisted highlight hidden in thumbnail',
        );
        expect(deletedThumbnailYellowCount).toBeLessThan(highlightedThumbnailYellowCount);
        await openAnnotationsTab(page);

        await saveViaWindowHandle(page);
        await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 0);
        await waitForActiveTabDirtyState(page, false);

        await clickEnabledToolbarAction(page, 'Undo');
        await waitForHighlightEditorCount(page, baselineCount + 1);
        await waitForActiveTabDirtyState(page, true);

        await saveViaWindowHandle(page);
        const restoredSummary = await waitForPdfAnnotationSubtypeCount(highlightFixturePath, 'Highlight', 1);
        expect(restoredSummary.bySubtype.Highlight ?? 0).toBe(1);
        await waitForActiveTabDirtyState(page, false);
    });

});
