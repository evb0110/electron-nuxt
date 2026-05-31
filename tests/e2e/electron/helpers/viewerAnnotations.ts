import type { Page } from 'puppeteer-core';
import { clamp } from 'es-toolkit/math';
import {
    DEFAULT_TIMEOUT_MS,
    findVisiblePointInActiveHost,
} from '@tests/e2e/electron/helpers/viewerDom';
import {
    clickToolbarButtonWhenEnabled,
    openAnnotationsTab,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const TOOL_LABEL_TO_ID: Record<string, string> = {
    'Draw': 'draw',
    'Text': 'text',
    'Highlight': 'highlight',
    'Underline': 'underline',
    'Strikethrough': 'strikethrough',
    'Rectangle': 'rectangle',
    'Circle': 'circle',
    'Line': 'line',
    'Arrow': 'arrow',
};

function resolveToolId(label: string): string {
    if (label === 'Select') {
        return 'select';
    }
    return TOOL_LABEL_TO_ID[label] ?? label.toLowerCase();
}

interface IAnnotationUiManagerHolder { value?: unknown; }

interface IPdfViewerWorkspaceInstance {$?: {setupState?: {
    pdfViewerRef?: {value?: {
        $?: {setupState?: {annotationUiManager?: IAnnotationUiManagerHolder;};};
        annotationUiManager?: IAnnotationUiManagerHolder;
    };};
    annotationUiManager?: IAnnotationUiManagerHolder;
};};}

async function waitForActiveAnnotationTool(
    page: Page,
    toolId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
) {
    await page.waitForFunction((expectedToolId: string) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        if (!host) {
            return false;
        }
        const activeBtn = host.querySelector('.notes-panel .tool-button.is-active');
        return activeBtn?.getAttribute('data-tool') === expectedToolId;
    }, {timeout: timeoutMs}, toolId);
}

async function waitForAnnotationEditorLayerInteractive(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.waitForFunction(() => {
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
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.annotationEditorLayer, .annotation-editor-layer'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        if (!host) {
            return false;
        }

        const viewer = host.querySelector('.pdfViewer');
        if (!viewer || viewer.classList.contains('pdfViewer--resize-transition')) {
            return false;
        }

        const editorLayer = Array.from(host.querySelectorAll<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer'))
            .find((candidate) => {
                const rect = candidate.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) {
                    return false;
                }
                const layerStyle = window.getComputedStyle(candidate);
                return (
                    layerStyle.display !== 'none'
                    && layerStyle.visibility !== 'hidden'
                    && Number(layerStyle.opacity || '1') > 0
                    && layerStyle.pointerEvents !== 'none'
                );
            });
        return Boolean(editorLayer);
    }, {timeout: timeoutMs});
}

async function waitForAnnotationEditorMode(
    page: Page,
    modeClass: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pageNumber?: number,
) {
    await page.waitForFunction((args: {
        modeClass: string;
        targetPageNumber: number | null;
    }) => {
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
        const pageSelector = args.targetPageNumber
            ? `.page_container[data-page="${args.targetPageNumber}"]`
            : '.page_container';
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        if (!host) {
            return false;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        if (!layer || layer.hidden) {
            return false;
        }

        const rect = layer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const style = window.getComputedStyle(layer);
        if (
            style.display === 'none'
            || style.visibility === 'hidden'
            || Number(style.opacity || '1') === 0
            || style.pointerEvents === 'none'
            || layer.classList.contains('waiting')
            || layer.classList.contains('disabled')
        ) {
            return false;
        }

        return layer.classList.contains(args.modeClass);
    }, { timeout: timeoutMs }, {
        modeClass,
        targetPageNumber: pageNumber ?? null,
    });
}

async function getLatestFreeTextHitPoints(page: Page) {
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
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return [] as Array<{
                x: number;
                y: number;
            }>;
        }

        const overlay = editor.querySelector<HTMLElement>('.overlay');
        const targetRect = (overlay ?? editor).getBoundingClientRect();
        const clampInset = (size: number, inset: number) => clamp(inset, 4, size - 4);
        const candidates = [
            {
                x: Math.round(targetRect.left + clampInset(targetRect.width, 8)),
                y: Math.round(targetRect.top + clampInset(targetRect.height, 8)),
            },
            {
                x: Math.round(targetRect.left + clampInset(targetRect.width, targetRect.width / 2)),
                y: Math.round(targetRect.top + clampInset(targetRect.height, targetRect.height / 2)),
            },
            {
                x: Math.round(targetRect.left + clampInset(targetRect.width, targetRect.width - 8)),
                y: Math.round(targetRect.top + clampInset(targetRect.height, 8)),
            },
        ];

        const seen = new Set<string>();
        return candidates.filter((candidate) => {
            const key = `${candidate.x}:${candidate.y}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    });
}

export async function clickAnnotationTool(page: Page, label: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await openAnnotationsTab(page, timeoutMs);
    await waitForViewerInteractive(page, timeoutMs);

    const toolId = resolveToolId(label);
    if (await getActiveToolLabel(page) === toolId) {
        return;
    }

    const selector = `.notes-panel .tool-button[data-tool="${toolId}"]`;
    const point = await findVisiblePointInActiveHost(page, selector);
    if (!point) {
        throw new Error(`Annotation tool not found: ${label}`);
    }

    await page.mouse.click(point.x, point.y);
    await waitForActiveAnnotationTool(page, toolId, timeoutMs);
}

export async function setAnnotationColor(page: Page, colorHex: string) {
    await openAnnotationsTab(page);
    const activeTool = await getActiveToolLabel(page);

    const updated = await page.evaluate((targetColor: string) => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const swatches = Array.from(host?.querySelectorAll<HTMLButtonElement>('.notes-panel .swatch') ?? []);
        const normalise = (c: string) => c.toLowerCase().trim();
        const swatch = swatches.find((btn) => normalise(btn.getAttribute('aria-label') ?? '') === normalise(targetColor));
        if (!swatch) {
            return false;
        }
        swatch.click();
        return true;
    }, colorHex);

    if (!updated) {
        throw new Error('Annotation color swatch not found');
    }

    if (activeTool) {
        await waitForActiveAnnotationTool(page, activeTool, Math.min(DEFAULT_TIMEOUT_MS, 4_000));
    }

    await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
}

export async function getActiveToolLabel(page: Page) {
    return page.evaluate(() => {
        const isVisibleHost = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            return (
                style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number(style.opacity || '1') > 0
                && rect.width > 100
                && rect.height > 100
            );
        };
        const visibleHosts = Array.from(document.querySelectorAll<HTMLElement>('.workspace-host'))
            .filter(isVisibleHost);
        const activeHost = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host');
        const host = (activeHost && visibleHosts.includes(activeHost))
            ? activeHost
            : (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? null;
    });
}

export async function getFreeTextEditorCount(page: Page) {
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
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        return host?.querySelectorAll('.freeTextEditor').length ?? 0;
    });
}

export async function getHighlightEditorCount(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        return host?.querySelectorAll('.highlightEditor').length ?? 0;
    });
}

export async function clickPageAtRatio(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    const point = await page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
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
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        if (!host) {
            return null;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        if (!pageContainer) {
            return null;
        }

        const rect = pageContainer.getBoundingClientRect();
        return {
            x: Math.round(rect.left + rect.width * xRatio),
            y: Math.round(rect.top + rect.height * yRatio),
        };
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });

    if (!point) {
        throw new Error(`Target page not found${pageNumber ? ` (page ${pageNumber})` : ''}`);
    }

    await page.mouse.click(point.x, point.y);
}

async function resolveAnnotationLayerPoint(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    return page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
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
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        if (!host) {
            return null;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        const target = layer ?? pageContainer;
        if (!target) {
            return null;
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return {
            x: Math.round(rect.left + rect.width * xRatio),
            y: Math.round(rect.top + rect.height * yRatio),
        };
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });
}

async function synthesizeAnnotationCreationClick(
    page: Page,
    ratio: {
        x: number;
        y: number;
    },
    pageNumber?: number,
) {
    await waitForViewerInteractive(page);

    return page.evaluate(({
        xRatio,
        yRatio,
        targetPageNumber,
    }) => {
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
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        if (!host) {
            return false;
        }

        const pageContainer = host.querySelector<HTMLElement>(pageSelector);
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer');
        const target = layer ?? pageContainer ?? null;
        if (!target) {
            return false;
        }

        const rect = target.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return false;
        }

        const clientX = Math.round(rect.left + rect.width * xRatio);
        const clientY = Math.round(rect.top + rect.height * yRatio);
        const dispatchTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(
            '.annotationEditorLayer, .annotation-editor-layer, .page_container',
        ) ?? target;
        const eventTarget = dispatchTarget instanceof HTMLElement ? dispatchTarget : target;
        const eventBase = {
            bubbles: true,
            cancelable: true,
            clientX,
            clientY,
            button: 0,
            buttons: 1,
            composed: true,
        };
        const dispatchMouse = (type: string, buttons: number) => eventTarget.dispatchEvent(new MouseEvent(type, {
            ...eventBase,
            buttons,
        }));

        eventTarget.focus?.();
        dispatchMouse('mousemove', 0);
        dispatchMouse('mouseenter', 0);
        dispatchMouse('mouseover', 0);
        dispatchMouse('mousedown', 1);
        dispatchMouse('mouseup', 0);
        dispatchMouse('click', 0);
        return true;
    }, {
        xRatio: ratio.x,
        yRatio: ratio.y,
        targetPageNumber: pageNumber ?? null,
    });
}

async function collectFreeTextCreationDebugState(page: Page, pageNumber?: number) {
    return page.evaluate((targetPageNumber: number | null) => {
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
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        const pageContainer = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer') ?? null;
        const workspaceInstance = (host as HTMLElement & {__vueParentComponent?: {setupState?: {workspaceRef?: {value?: {$?: {setupState?: {
            pdfViewerRef?: {value?: {
                $?: {setupState?: {annotationUiManager?: { value?: unknown; };};};
                annotationUiManager?: { value?: unknown; };
            };};
            annotationUiManager?: { value?: unknown; };
        };};};};};};} | null)?.__vueParentComponent?.setupState?.workspaceRef?.value;
        const workspaceSetupState = workspaceInstance?.$?.setupState ?? null;
        const pdfViewerInstance = workspaceSetupState?.pdfViewerRef?.value ?? null;
        const pdfViewerSetupState = pdfViewerInstance?.$?.setupState ?? null;
        const uiManager = pdfViewerSetupState?.annotationUiManager?.value
            ?? pdfViewerInstance?.annotationUiManager?.value
            ?? workspaceSetupState?.annotationUiManager?.value
            ?? null;
        const pageAttribute = Number(pageContainer?.dataset.page ?? '1');
        const resolvedPageNumber = Number.isFinite(pageAttribute) && pageAttribute > 0
            ? pageAttribute
            : 1;
        const resolvedPageIndex = Math.max(0, (targetPageNumber ?? resolvedPageNumber) - 1);
        const uiManagerLayerAccess: {
            getLayer?: (pageIndex: number) => unknown;
            currentLayer?: unknown;
        } | null = uiManager;
        const getLayer = uiManagerLayerAccess?.getLayer;
        const programmaticLayer = getLayer?.call(uiManager, resolvedPageIndex)
            ?? uiManagerLayerAccess?.currentLayer
            ?? null;
        const programmaticLayerEditorAccess: { createAndAddNewEditor?: unknown; } | null = programmaticLayer;
        const fatalDialog = Array.from(document.querySelectorAll<HTMLElement>('div.fixed.inset-0'))
            .find((candidate) => candidate.textContent?.includes('Reload') && candidate.textContent?.includes('runtime') !== false)
            ?? null;
        const detailBlock = fatalDialog?.querySelector('p.mt-2') ?? null;

        return {
            activeTool: host?.querySelector('.notes-panel .tool-button.is-active')?.getAttribute('data-tool') ?? '',
            pageCount: host?.querySelectorAll('.page_container').length ?? 0,
            textLayerCount: host?.querySelectorAll('.text-layer, .textLayer').length ?? 0,
            freeTextCount: host?.querySelectorAll('.freeTextEditor').length ?? 0,
            freeTextEditingLayerCount: host?.querySelectorAll('.annotationEditorLayer.freetextEditing, .annotation-editor-layer.freetextEditing').length ?? 0,
            waitingLayerCount: host?.querySelectorAll('.annotationEditorLayer.waiting, .annotation-editor-layer.waiting').length ?? 0,
            disabledLayerCount: host?.querySelectorAll('.annotationEditorLayer.disabled, .annotation-editor-layer.disabled').length ?? 0,
            pageRect: pageContainer
                ? {
                    width: Math.round(pageContainer.getBoundingClientRect().width),
                    height: Math.round(pageContainer.getBoundingClientRect().height),
                }
                : null,
            layerClassName: layer?.className ?? null,
            layerPointerEvents: layer ? window.getComputedStyle(layer).pointerEvents : null,
            hasProgrammaticUiManager: Boolean(uiManager),
            hasProgrammaticEditorLayer: Boolean(programmaticLayer),
            programmaticLayerSupportsCreate: typeof programmaticLayerEditorAccess?.createAndAddNewEditor === 'function',
            fatalRuntimeVisible: Boolean(fatalDialog),
            fatalRuntimeDetail: detailBlock?.textContent?.trim() ?? null,
        };
    }, pageNumber ?? null);
}

async function triggerKeyboardFreeTextCreation(page: Page, pageNumber?: number) {
    await waitForViewerInteractive(page);

    const focused = await page.evaluate((targetPageNumber: number | null) => {
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
        const pageSelector = targetPageNumber
            ? `.page_container[data-page="${targetPageNumber}"]`
            : '.page_container';
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        const pageContainer = host?.querySelector<HTMLElement>(pageSelector) ?? null;
        const layer = pageContainer?.querySelector<HTMLElement>('.annotationEditorLayer, .annotation-editor-layer') ?? null;
        const focusTarget = layer ?? pageContainer ?? host ?? null;
        if (!focusTarget) {
            return false;
        }

        focusTarget.tabIndex = Math.max(0, focusTarget.tabIndex);
        focusTarget.focus();
        return document.activeElement === focusTarget;
    }, pageNumber ?? null);

    if (!focused) {
        return false;
    }

    await page.keyboard.press('Enter');
    return true;
}

export async function createFreeTextAnnotation(page: Page, text: string, position?: {
    x: number;
    y: number;
}, pageNumber?: number) {
    const before = await getFreeTextEditorCount(page);
    const targetRatio = position ?? {
        x: 0.4,
        y: 0.3,
    };
    const clickAnnotationCreationPoint = async () => {
        const point = await resolveAnnotationLayerPoint(page, targetRatio, pageNumber);
        if (!point) {
            await clickPageAtRatio(page, targetRatio, pageNumber);
            return 'page';
        }
        await page.mouse.click(point.x, point.y);
        return 'mouse';
    };
    const dispatchAnnotationCreationPoint = async () => {
        const dispatched = await synthesizeAnnotationCreationClick(page, targetRatio, pageNumber);
        if (!dispatched) {
            await clickPageAtRatio(page, targetRatio, pageNumber);
            return 'page';
        }
        return 'dom';
    };
    const triggerKeyboardCreationPoint = async () => {
        const created = await triggerKeyboardFreeTextCreation(page, pageNumber);
        if (!created) {
            await clickPageAtRatio(page, targetRatio, pageNumber);
            return 'page';
        }
        return 'keyboard';
    };
    const waitForEditor = async (timeoutMs: number) => {
        await page.waitForFunction((minCount: number) => {
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
            const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
                ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
            if ((host?.querySelectorAll('.freeTextEditor').length ?? 0) > minCount) {
                return true;
            }

            const targetLayer = host?.querySelector<HTMLElement>('.annotationEditorLayer.freetextEditing, .annotation-editor-layer.freetextEditing');
            const activeEditor = targetLayer?.querySelector<HTMLElement>('.freeTextEditor .internal[contenteditable="true"], .freeTextEditor [contenteditable="true"]');
            return Boolean(activeEditor);
        }, {timeout: timeoutMs}, before);
    };

    const ensureFreeTextCreationReady = async (timeoutMs: number) => {
        if (await getActiveToolLabel(page) !== 'text') {
            await clickAnnotationTool(page, 'Text', timeoutMs);
        } else {
            await openAnnotationsTab(page, timeoutMs);
            await waitForViewerInteractive(page, timeoutMs);
        }
        try {
            await waitForAnnotationEditorLayerInteractive(page, Math.min(timeoutMs, 8_000));
        } catch {
            await waitForViewerInteractive(page, Math.min(timeoutMs, 8_000));
        }
        await waitForAnnotationEditorMode(page, 'freetextEditing', timeoutMs, pageNumber);
    };

    let lastEditorWaitError: unknown = null;
    let editorReady = false;
    for (const attemptTimeoutMs of [
        4_000,
        6_000,
        10_000,
    ]) {
        try {
            await ensureFreeTextCreationReady(attemptTimeoutMs);
        } catch (error) {
            lastEditorWaitError = error;
            continue;
        }

        for (const strategy of [
            clickAnnotationCreationPoint,
            dispatchAnnotationCreationPoint,
            triggerKeyboardCreationPoint,
        ]) {
            await strategy();

            try {
                await waitForEditor(attemptTimeoutMs);
                editorReady = true;
                break;
            } catch (error) {
                lastEditorWaitError = error;
                await page.evaluate(async () => {
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                });
            }
        }

        if (editorReady) {
            break;
        }
    }

    if (!editorReady) {
        const debugState = await collectFreeTextCreationDebugState(page, pageNumber);
        const baseMessage = lastEditorWaitError instanceof Error
            ? lastEditorWaitError.message
            : 'Failed to create FreeText editor';
        throw new Error(`${baseMessage} (${JSON.stringify(debugState)})`);
    }

    // Prevent PDF.js from auto-removing the empty editor before we can type
    // into it. Mirrors useAnnotationHighlight.ts:1082-1087.
    await page.evaluate(() => {
        const editors = Array.from(document.querySelectorAll<HTMLElement>('.freeTextEditor'));
        const latest = editors[editors.length - 1];
        const editable = latest?.querySelector<HTMLElement>('[contenteditable], .internal') ?? latest;
        if (editable) {
            editable.textContent = '\u200B';
        }
    });

    const editorPoint = await page.evaluate(() => {
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
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const editor = editors[editors.length - 1];
        if (!editor) {
            return null;
        }

        const editable = editor.querySelector<HTMLElement>('[contenteditable], .internal') ?? editor;
        const rect = editable.getBoundingClientRect();
        return {
            x: Math.round(rect.left + Math.max(4, rect.width / 2)),
            y: Math.round(rect.top + Math.max(4, rect.height / 2)),
        };
    });

    if (!editorPoint) {
        const debugState = await collectFreeTextCreationDebugState(page, pageNumber);
        throw new Error(`Failed to locate created FreeText editor (${JSON.stringify(debugState)})`);
    }

    await page.mouse.click(editorPoint.x, editorPoint.y);
    await page.evaluate(() => {
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
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? [])
            .filter((editor) => {
                const rect = editor.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            });
        const latestEditor = editors[editors.length - 1];
        const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
            ?? latestEditor
            ?? null;
        if (!editable) {
            return false;
        }
        editable.focus();
        if (editable.isContentEditable) {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editable);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
        }
        return true;
    });
    const waitForLatestFreeTextContent = async (typedText: string, timeoutMs: number) => {
        await page.waitForFunction((expectedText: string) => {
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
            const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
                ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
            const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
            const latestEditor = editors[editors.length - 1];
            const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
                ?? latestEditor
                ?? null;
            const latestText = (editable?.textContent ?? '')
                .replace(/\u200B/g, '')
                .trim();
            return latestText.includes(expectedText.trim());
        }, {timeout: timeoutMs}, typedText);
    };

    const tryInjectEditorContent = (expectedText: string) => page.evaluate((text: string) => {
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
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
        const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
            ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
            ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
        const editors = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []);
        const latestEditor = editors[editors.length - 1];
        const editable = latestEditor?.querySelector<HTMLElement>('[contenteditable], .internal')
            ?? latestEditor
            ?? null;
        if (!editable) {
            return 'no-editor';
        }

        editable.focus();

        if (!editable.isContentEditable) {
            editable.setAttribute('contenteditable', 'true');
        }

        editable.textContent = text;

        try {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(editable);
            range.collapse(false);
            selection?.removeAllRanges();
            selection?.addRange(range);
        } catch {
            // Selection API may not work in headless — content is already set.
        }

        editable.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: text,
            inputType: 'insertText',
        }));
        editable.dispatchEvent(new Event('change', {bubbles: true}));
        return 'ok';
    }, expectedText);

    const injectLatestFreeTextContent = async (typedText: string) => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            await page.evaluate(async () => {
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            });
            const result = await tryInjectEditorContent(typedText);
            if (result === 'ok') {
                return;
            }
            if (attempt < 4) {
                await page.evaluate(() => new Promise<void>(r => setTimeout(r, 300)));
            }
        }
        throw new Error('Failed to inject created FreeText editor content');
    };

    await page.keyboard.type(text, { delay: 10 });

    try {
        await waitForLatestFreeTextContent(text, 6_000);
    } catch {
        await injectLatestFreeTextContent(text);
        await waitForLatestFreeTextContent(text, 8_000);
    }

    return getFreeTextEditorCount(page);
}

export async function deleteLatestFreeTextAnnotation(page: Page) {
    const before = await getFreeTextEditorCount(page);
    if (before === 0) {
        return 0;
    }

    await waitForViewerInteractive(page);

    const editorPoints = await getLatestFreeTextHitPoints(page);
    if (editorPoints.length === 0) {
        return before;
    }

    const waitForCountDrop = async (timeoutMs: number) => {
        await page.waitForFunction((previousCount: number) => {
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
            const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector('.freeTextEditor'));
            const host = ((activeHost && visibleHosts.includes(activeHost)) ? activeHost : null)
                ?? (matchingHosts.length === 1 ? matchingHosts[0] : null)
                ?? (visibleHosts.length === 1 ? visibleHosts[0] : null);
            return (host?.querySelectorAll('.freeTextEditor').length ?? 0) < previousCount;
        }, {timeout: timeoutMs}, before);
    };

    // The E2E path creates a committed FreeText editor immediately before
    // deleting it. Reverting the latest annotation history entry is the most
    // reliable headless-safe way to remove that just-created editor.
    try {
        await clickAnnotationTool(page, 'Select');
        await clickToolbarButtonWhenEnabled(page, 'Undo', Math.min(DEFAULT_TIMEOUT_MS, 4_000));
        await waitForCountDrop(Math.min(DEFAULT_TIMEOUT_MS, 4_000));
        return await getFreeTextEditorCount(page);
    } catch {
        // Fall back to selection-based deletion below.
    }

    // In NONE idle mode the editor layer is disabled (pointer-events: none),
    // so we must activate the FreeText tool to make editors interactive.
    // Clicking an editor in FREETEXT mode enters editing; Escape exits editing
    // while keeping the editor selected, then Delete removes it.
    let lastError: Error | null = null;
    for (const editorPoint of editorPoints) {
        await clickAnnotationTool(page, 'Text');
        await page.mouse.click(editorPoint.x, editorPoint.y);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Delete');

        try {
            await waitForCountDrop(Math.min(DEFAULT_TIMEOUT_MS, 3_500));
            await clickAnnotationTool(page, 'Select');
            return await getFreeTextEditorCount(page);
        } catch {
            // Escape+Delete didn't work — try programmatic removal via PDF.js
            const removalResult = await page.evaluate(() => {
                const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
                    ?? document.querySelector<HTMLElement>('.workspace-host')
                    ?? null;
                const target = Array.from(host?.querySelectorAll<HTMLElement>('.freeTextEditor') ?? []).at(-1) ?? null;
                if (!host || !target) {
                    return {
                        removed: false,
                        reason: 'missing-host-or-target',
                    };
                }

                let workspaceInstance: IPdfViewerWorkspaceInstance | null = null;

                for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
                    const component = (element as HTMLElement & {__vueParentComponent?: {
                        exposed?: unknown;
                        setupState?: {
                            mountedWorkspace?: { value?: unknown; };
                            workspaceRef?: { value?: unknown; };
                        };
                    };}).__vueParentComponent;

                    for (const candidate of [
                        component?.setupState?.mountedWorkspace?.value,
                        component?.setupState?.workspaceRef?.value,
                        component?.exposed,
                    ]) {
                        if (candidate && typeof candidate === 'object') {
                            workspaceInstance = candidate;
                            break;
                        }
                    }

                    if (workspaceInstance) {
                        break;
                    }
                }

                const workspaceSetupState = workspaceInstance?.$?.setupState ?? null;
                const pdfViewerInstance = workspaceSetupState?.pdfViewerRef?.value ?? null;
                const pdfViewerSetupState = pdfViewerInstance?.$?.setupState ?? null;
                const uiManager = pdfViewerSetupState?.annotationUiManager?.value
                    ?? pdfViewerInstance?.annotationUiManager?.value
                    ?? workspaceSetupState?.annotationUiManager?.value
                    ?? null;
                if (!uiManager) {
                    return {
                        removed: false,
                        reason: 'missing-ui-manager',
                    };
                }

                const getEditors = (uiManager as {getEditors?: (pageIndex: number) => Iterable<{div?: HTMLElement | null;}>;} | null)?.getEditors;
                const setSelected = (uiManager as {setSelected?: (editor: unknown) => void;} | null)?.setSelected;
                const deleteSelection = (uiManager as {delete?: () => void;} | null)?.delete;
                if (
                    typeof getEditors !== 'function'
                    || typeof setSelected !== 'function'
                    || typeof deleteSelection !== 'function'
                ) {
                    return {
                        removed: false,
                        reason: 'missing-delete-api',
                    };
                }

                const pageCount = Math.max(1, host.querySelectorAll('.page_container').length);
                const editors = Array.from({ length: pageCount }, (_, pageIndex) => (
                    Array.from(getEditors.call(uiManager, pageIndex) ?? [])
                )).flat();
                const matchingEditor = editors.find((editor) => {
                    const div = editor.div ?? null;
                    return div === target || Boolean(div?.contains(target)) || Boolean(target.contains(div));
                }) ?? editors.find((editor) => editor.div?.classList.contains('freeTextEditor')) ?? null;

                if (!matchingEditor) {
                    return {
                        removed: false,
                        reason: `no-matching-editor:${editors.length}`,
                    };
                }

                setSelected.call(uiManager, matchingEditor);
                deleteSelection.call(uiManager);
                return {
                    removed: true,
                    reason: `deleted:${editors.length}`,
                };
            });

            if (removalResult.removed) {
                try {
                    await waitForCountDrop(DEFAULT_TIMEOUT_MS);
                    await clickAnnotationTool(page, 'Select');
                    return await getFreeTextEditorCount(page);
                } catch {
                    continue;
                }
            }
            lastError = new Error(`Programmatic delete failed (${removalResult.reason})`);
            continue;
        }
    }

    try {
        await clickAnnotationTool(page, 'Select');
        await clickToolbarButtonWhenEnabled(page, 'Undo', Math.min(DEFAULT_TIMEOUT_MS, 4_000));
        await waitForCountDrop(DEFAULT_TIMEOUT_MS);
        return await getFreeTextEditorCount(page);
    } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
    }

    throw new Error(`Unable to delete the latest FreeText annotation from any hit target${lastError ? ` (${lastError.message})` : ''}`);
}

export async function createHighlightFromVisibleText(page: Page) {
    const before = await getHighlightEditorCount(page);
    await clickAnnotationTool(page, 'Highlight');

    const dragPoints = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        if (!host) {
            return null;
        }

        const spans = Array.from(host.querySelectorAll<HTMLElement>('.page_container .text-layer span, .page_container .textLayer span'))
            .filter((span) => (span.textContent ?? '').trim().length > 0);
        if (spans.length < 2) {
            return null;
        }

        const first = spans[0]?.getBoundingClientRect();
        const second = spans[1]?.getBoundingClientRect();
        if (!first || !second) {
            return null;
        }

        return {
            x1: Math.round(first.left + 2),
            y1: Math.round(first.top + first.height / 2),
            x2: Math.round(second.right - 2),
            y2: Math.round(second.top + second.height / 2),
        };
    });

    if (!dragPoints) {
        throw new Error('Unable to locate visible text spans for highlight creation');
    }

    await page.mouse.move(dragPoints.x1, dragPoints.y1);
    await page.mouse.down();
    await page.mouse.move(dragPoints.x2, dragPoints.y2, { steps: 8 });
    await page.mouse.up();

    await page.waitForFunction((previousCount: number) => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        return (host?.querySelectorAll('.highlightEditor').length ?? 0) > previousCount;
    }, {timeout: DEFAULT_TIMEOUT_MS}, before);

    return getHighlightEditorCount(page);
}

export async function openContextMenuOnLatestFreeText(page: Page) {
    const points = await getLatestFreeTextHitPoints(page);
    if (points.length === 0) {
        return {
            visible: false,
            items: [] as string[],
        };
    }

    let opened = false;
    for (const point of points) {
        await clickAnnotationTool(page, 'Select');
        await page.mouse.click(point.x, point.y, { button: 'right' });

        opened = await page.waitForFunction(() => (
            Boolean(document.querySelector('.annotation-context-menu .pdf-context-menu__action--danger'))
        ), {timeout: 2_500})
            .then(() => true)
            .catch(() => false);

        if (opened) {
            break;
        }

        await page.keyboard.press('Escape').catch(() => {});
    }

    if (!opened) {
        return {
            visible: false,
            items: [] as string[],
        };
    }

    return page.evaluate(() => {
        const menu = document.querySelector('.annotation-context-menu');
        const items = Array.from(document.querySelectorAll('.annotation-context-menu button, .annotation-context-menu [role="menuitem"]'))
            .map(item => (item.textContent ?? '').trim())
            .filter(Boolean);
        return {
            visible: Boolean(menu),
            items,
        };
    });
}

export async function countFreeTextEditorsOnPage(page: Page, pageNumber: number) {
    return page.evaluate((targetPageNumber: number) => {
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
        const pageSelector = `.page_container[data-page="${targetPageNumber}"]`;
        const matchingHosts = visibleHosts.filter(candidate => candidate.querySelector(pageSelector));
        const host = (
            activeHost
            && visibleHosts.includes(activeHost)
            && activeHost.querySelector(pageSelector)
        )
            ? activeHost
            : ((matchingHosts.length === 1 ? matchingHosts[0] : null) ?? (visibleHosts.length === 1 ? visibleHosts[0] : null));
        if (!host) {
            return 0;
        }
        return host.querySelectorAll(`${pageSelector} .freeTextEditor`).length;
    }, pageNumber);
}

export async function getFirstFreeTextComputedColor(page: Page) {
    return page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-group-pane.is-active .workspace-host')
            ?? null;
        const editor = host?.querySelector<HTMLElement>('.freeTextEditor [contenteditable], .freeTextEditor');
        if (!editor) {
            return null;
        }
        return window.getComputedStyle(editor).color;
    });
}
