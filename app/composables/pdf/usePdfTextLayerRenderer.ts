import { TextLayer } from '@app/services/pdfjs/runtimeLib';
import type { PDFPageProxy } from 'pdfjs-dist';
import type { MaybeRefOrGetter } from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdf';
import { usePdfSearchHighlight } from '@app/composables/usePdfSearchHighlight';
import { useTextLayerSelection } from '@app/composables/useTextLayerSelection';
import { usePdfWordBoxes } from '@app/composables/usePdfWordBoxes';
import { useOcrTextContent } from '@app/composables/pdf/useOcrTextContent';
import { getPageContainer } from '@app/composables/pdf/pdfPageBufferManager';
import {
    getHighlightMode,
    isHighlightDebugEnabled as isHighlightDebugEnabledFromStorage,
    isHighlightDebugVerboseEnabled as isHighlightDebugVerboseEnabledFromStorage,
} from '@app/composables/pdfSearchHighlightCss';
import { clearTextLayerIndexCache } from '@app/composables/pdfSearchHighlightDom';
import { BrowserLogger } from '@app/utils/browserLogger';
import { measureDevPerf } from '@app/utils/devPerf';
import { logPdfNav } from '@app/utils/pdfNavLog';
import { guardAsync } from '@app/utils/asyncGuard';

interface IHighlightDebugInfo {
    userUnit: number;
    totalScaleFactor: number;
    viewportWidth: number;
    viewportHeight: number;
    rawPageWidth: number;
    rawPageHeight: number;
    canvasPixelWidth: number;
    canvasPixelHeight: number;
    renderScaleX: number;
    renderScaleY: number;
}

interface IPageHighlightSignatureState {
    signatureByPage: Map<number, string>;
    pendingRoot: HTMLElement | null;
    rafId: number;
    continuationRafId: number;
    refreshVersion: number;
}

interface IHighlightDebugGuard {
    current: IPdfSearchMatch;
    query: string;
    scale: number;
}

interface IHighlightDebugRects {
    canvasRect: DOMRect;
    textRect: DOMRect;
    containerRect: DOMRect | null;
    canvasHostRect: DOMRect | null;
    highlightRect: DOMRect | null;
    computedTotalScaleFactor: string;
    currentSpanInfo: string;
}

const HIGHLIGHT_REFRESH_BUDGET_MS = 8;
const HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE = 4;

export const usePdfTextLayerRenderer = (deps: {
    searchPageMatches: MaybeRefOrGetter<Map<number, IPdfPageMatches>>;
    currentSearchMatch: MaybeRefOrGetter<IPdfSearchMatch | null>;
    workingCopyPath: MaybeRefOrGetter<string | null>;
    effectiveScale: MaybeRefOrGetter<number>;
}) => {
    const { setupTextLayer } = useTextLayerSelection();
    const {
        clearHighlights,
        highlightPage,
        getCurrentMatchRanges,
    } = usePdfSearchHighlight();
    const {
        renderPageWordBoxes,
        clearWordBoxes,
        isOcrDebugEnabled,
        clearOcrDebugBoxes,
        renderOcrDebugBoxes,
    } = usePdfWordBoxes();
    const { getOcrTextContent } = useOcrTextContent();

    let lastHighlightDebugKey: string | null = null;
    const pageHighlightState: IPageHighlightSignatureState = {
        signatureByPage: new Map<number, string>(),
        pendingRoot: null,
        rafId: 0,
        continuationRafId: 0,
        refreshVersion: 0,
    };

    tryOnScopeDispose(() => {
        if (pageHighlightState.rafId !== 0 && typeof window !== 'undefined') {
            window.cancelAnimationFrame(pageHighlightState.rafId);
            pageHighlightState.rafId = 0;
        }
        if (pageHighlightState.continuationRafId !== 0 && typeof window !== 'undefined') {
            window.cancelAnimationFrame(pageHighlightState.continuationRafId);
            pageHighlightState.continuationRafId = 0;
        }
        pageHighlightState.pendingRoot = null;
        pageHighlightState.signatureByPage.clear();
    });

    function buildWordKey(word: {
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }) {
        return `${word.text}|${word.x}|${word.y}|${word.width}|${word.height}`;
    }

    function collectWordsFromPageMatches(pageMatchData: IPdfPageMatches) {
        const wordsByKey = new Map<string, NonNullable<NonNullable<IPdfPageMatches['matches'][number]['words']>[number]>>();

        pageMatchData.matches.forEach((match) => {
            match.words?.forEach((word) => {
                wordsByKey.set(buildWordKey(word), word);
            });
        });

        return Array.from(wordsByKey.values());
    }

    function buildCurrentMatchSignature(currentMatchValue: IPdfSearchMatch) {
        return [
            'current',
            currentMatchValue.matchIndex,
            currentMatchValue.pageMatchIndex ?? -1,
            currentMatchValue.startOffset,
            currentMatchValue.endOffset,
            currentMatchValue.words?.length ?? 0,
        ].join(':');
    }

    function isCurrentMatchForPage(
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number | undefined,
    ): currentMatchValue is IPdfSearchMatch {
        return Boolean(currentMatchValue && currentMatchValue.pageIndex === pageIndex);
    }

    function buildPageHighlightSignature(
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
    ) {
        if (!pageMatchData || pageMatchData.matches.length === 0) {
            return isCurrentMatchForPage(currentMatchValue, pageMatchData?.pageIndex)
                ? `empty|current=${currentMatchValue.matchIndex}:${currentMatchValue.pageMatchIndex ?? -1}`
                : 'empty';
        }

        const parts: string[] = [pageMatchData.signatureToken ?? `${pageMatchData.pageIndex}:${pageMatchData.matches.length}`];

        if (isCurrentMatchForPage(currentMatchValue, pageMatchData.pageIndex)) {
            parts.push(buildCurrentMatchSignature(currentMatchValue));
        }

        return parts.join('|');
    }

    function renderWordBoxesForPageMatch(
        container: HTMLElement,
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
        pageIndex: number,
    ) {
        clearWordBoxes(container);

        if (!pageMatchData || pageMatchData.matches.length === 0) {
            return;
        }

        const firstMatch = pageMatchData.matches.at(0);
        const firstMatchWords = firstMatch?.words ?? [];
        if (!firstMatch || firstMatchWords.length === 0) {
            return;
        }

        const allWords = collectWordsFromPageMatches(pageMatchData);
        const currentMatchWords = new Set<string>();
        if (currentMatchValue && currentMatchValue.pageIndex === pageIndex && currentMatchValue.words) {
            currentMatchValue.words.forEach((word) => {
                currentMatchWords.add(word.text);
            });
        }

        renderPageWordBoxes(
            container,
            allWords,
            firstMatch.pageWidth,
            firstMatch.pageHeight,
            currentMatchWords.size > 0 ? currentMatchWords : undefined,
        );
    }

    function getCurrentTime() {
        return typeof performance !== 'undefined'
            ? performance.now()
            : Date.now();
    }

    function runPendingHighlightRefresh(
        flushSearchHighlightRefresh: (root: HTMLElement | null, refreshVersion: number) => void,
    ) {
        const pendingRoot = pageHighlightState.pendingRoot;
        pageHighlightState.pendingRoot = null;
        if (pendingRoot) {
            flushSearchHighlightRefresh(pendingRoot, pageHighlightState.refreshVersion);
        }
    }

    function shouldPauseHighlightRefreshSlice(processedPages: number, sliceStartedAt: number) {
        const elapsed = getCurrentTime() - sliceStartedAt;
        return processedPages >= HIGHLIGHT_REFRESH_MAX_PAGES_PER_SLICE
            || elapsed >= HIGHLIGHT_REFRESH_BUDGET_MS;
    }

    function refreshSearchHighlightsForPage(
        container: HTMLElement,
        mountedPageNumber: number,
        pageMatchData: IPdfPageMatches | null,
        currentMatchValue: IPdfSearchMatch | null,
    ) {
        const pageIndex = mountedPageNumber - 1;
        const signature = buildPageHighlightSignature(pageMatchData, currentMatchValue);
        const previousSignature = pageHighlightState.signatureByPage.get(mountedPageNumber);
        if (previousSignature === signature) {
            return;
        }

        const textLayerDiv = container.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            pageHighlightState.signatureByPage.set(mountedPageNumber, signature);
            return;
        }

        const canvas = container.querySelector<HTMLCanvasElement>('canvas') ?? null;
        try {
            if (pageMatchData && pageMatchData.matches.length > 0) {
                highlightPage(
                    textLayerDiv,
                    pageMatchData,
                    currentMatchValue,
                );
            } else {
                clearHighlights(textLayerDiv);
            }

            renderWordBoxesForPageMatch(container, pageMatchData, currentMatchValue, pageIndex);

            if (canvas) {
                maybeLogHighlightDebug(pageIndex + 1, pageMatchData, canvas, textLayerDiv);
            }
        } catch (error) {
            BrowserLogger.warn('pdf-text-layer', 'Failed to refresh search highlights', {
                pageNumber: mountedPageNumber,
                error,
            });
        }

        pageHighlightState.signatureByPage.set(mountedPageNumber, signature);
    }

    function scheduleSearchHighlightRefresh(containerRoot: HTMLElement) {
        const scheduleContinuation = (callback: () => void) => {
            if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
                callback();
                return;
            }

            pageHighlightState.continuationRafId = window.requestAnimationFrame(() => {
                pageHighlightState.continuationRafId = 0;
                callback();
            });
        };

        const flushSearchHighlightRefresh = (
            root: HTMLElement | null,
            refreshVersion: number,
        ) => {
            if (!root || ('isConnected' in root && root.isConnected === false)) {
                return;
            }

            const pageContainers = Array.from(root.querySelectorAll<HTMLElement>('.page_container'));
            const searchMatchesValue = toValue(deps.searchPageMatches);
            const currentMatchValue = toValue(deps.currentSearchMatch);
            let nextIndex = 0;

            const processSlice = () => {
                if (refreshVersion !== pageHighlightState.refreshVersion) {
                    runPendingHighlightRefresh(flushSearchHighlightRefresh);
                    return;
                }

                const sliceStartedAt = getCurrentTime();

                measureDevPerf('pdf:highlight-refresh-slice', () => {
                    let processedPages = 0;

                    while (nextIndex < pageContainers.length) {
                        const container = pageContainers[nextIndex]!;
                        nextIndex += 1;
                        processedPages += 1;

                        const mountedPageNumber = Number.parseInt(container.dataset.page ?? '', 10);
                        if (!Number.isFinite(mountedPageNumber) || mountedPageNumber < 1) {
                            continue;
                        }

                        const pageIndex = mountedPageNumber - 1;
                        const pageMatchData = searchMatchesValue?.get(pageIndex) ?? null;
                        refreshSearchHighlightsForPage(
                            container,
                            mountedPageNumber,
                            pageMatchData,
                            currentMatchValue,
                        );

                        if (shouldPauseHighlightRefreshSlice(processedPages, sliceStartedAt)) {
                            break;
                        }
                    }
                }, {
                    thresholdMs: 8,
                    details: {
                        mountedPages: pageContainers.length,
                        remainingPages: Math.max(0, pageContainers.length - nextIndex),
                    },
                });

                if (nextIndex < pageContainers.length) {
                    scheduleContinuation(processSlice);
                    return;
                }

                if (pageHighlightState.pendingRoot && pageHighlightState.pendingRoot !== root) {
                    runPendingHighlightRefresh(flushSearchHighlightRefresh);
                }
            };

            processSlice();
        };

        pageHighlightState.pendingRoot = containerRoot;
        pageHighlightState.refreshVersion += 1;

        if (pageHighlightState.continuationRafId !== 0) {
            return;
        }

        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
            const root = pageHighlightState.pendingRoot;
            pageHighlightState.pendingRoot = null;
            flushSearchHighlightRefresh(root, pageHighlightState.refreshVersion);
            return;
        }

        if (pageHighlightState.rafId !== 0) {
            return;
        }

        pageHighlightState.rafId = window.requestAnimationFrame(() => {
            pageHighlightState.rafId = 0;

            const root = pageHighlightState.pendingRoot;
            pageHighlightState.pendingRoot = null;
            flushSearchHighlightRefresh(root, pageHighlightState.refreshVersion);
        });
    }

    function isHighlightDebugEnabled() {
        return isHighlightDebugEnabledFromStorage();
    }

    function isHighlightDebugVerboseEnabled() {
        return isHighlightDebugVerboseEnabledFromStorage();
    }

    function getHighlightDebugGuard(
        pageNumber: number,
        pageMatchData: IPdfPageMatches | null,
    ): IHighlightDebugGuard | null {
        if (!isHighlightDebugEnabled()) {
            return null;
        }

        const current = toValue(deps.currentSearchMatch);
        if (!current || current.pageIndex !== pageNumber - 1) {
            return null;
        }

        const query = pageMatchData?.searchQuery ?? '';
        const scale = toValue(deps.effectiveScale);
        const key = `${current.pageIndex}:${current.matchIndex}:${query}:${scale}`;
        if (key === lastHighlightDebugKey) {
            return null;
        }
        lastHighlightDebugKey = key;

        return {
            current,
            query,
            scale,
        };
    }

    function formatHighlightDebugRect(rect: DOMRect) {
        return `${rect.left.toFixed(2)},${rect.top.toFixed(2)} ${rect.width.toFixed(2)}x${rect.height.toFixed(2)}`;
    }

    function getCurrentSpanDebugInfo(currentMark: HTMLElement | null) {
        if (!isHighlightDebugVerboseEnabled() || typeof window === 'undefined') {
            return '';
        }

        const span = currentMark?.closest('span');
        if (!span) {
            return '';
        }

        const spanStyle = window.getComputedStyle(span);
        const scaleX = spanStyle.getPropertyValue('--scale-x').trim();
        const fontHeight = spanStyle.getPropertyValue('--font-height').trim();
        return [
            `spanFont=${JSON.stringify(spanStyle.font)}`,
            `spanFamily=${JSON.stringify(spanStyle.fontFamily)}`,
            `spanWeight=${spanStyle.fontWeight}`,
            `spanSize=${spanStyle.fontSize}`,
            `spanTransform=${JSON.stringify(spanStyle.transform)}`,
            `spanScaleX=${JSON.stringify(scaleX)}`,
            `spanFontHeightVar=${JSON.stringify(fontHeight)}`,
            `spanText=${JSON.stringify(span.textContent?.slice(0, 60) ?? '')}`,
        ].join(' ');
    }

    function collectHighlightDebugRects(
        canvas: HTMLCanvasElement,
        textLayerDiv: HTMLElement,
    ): IHighlightDebugRects {
        const canvasRect = canvas.getBoundingClientRect();
        const textRect = textLayerDiv.getBoundingClientRect();
        const pageContainer = textLayerDiv.closest<HTMLElement>('.page_container');
        const containerRect = pageContainer?.getBoundingClientRect() ?? null;
        const canvasHostRect = pageContainer?.querySelector<HTMLElement>('.page_canvas')?.getBoundingClientRect() ?? null;
        const computedTotalScaleFactor = typeof window !== 'undefined'
            ? window.getComputedStyle(textLayerDiv).getPropertyValue('--total-scale-factor').trim()
            : '';

        const currentRange = getCurrentMatchRanges(textLayerDiv).at(0) ?? null;
        const currentRangeRect = currentRange?.getBoundingClientRect() ?? null;
        const currentMark = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        const currentMarkRect = currentMark?.getBoundingClientRect() ?? null;
        const highlightRect = currentRangeRect ?? currentMarkRect;
        const currentSpanInfo = getCurrentSpanDebugInfo(currentMark);

        return {
            canvasRect,
            textRect,
            containerRect,
            canvasHostRect,
            highlightRect,
            computedTotalScaleFactor,
            currentSpanInfo,
        };
    }

    function formatHighlightDebugInfo(
        debugInfo: IHighlightDebugInfo | undefined,
        computedTotalScaleFactor: string,
    ) {
        if (!debugInfo) {
            return [
                '',
                '',
                '',
                '',
            ];
        }

        return [
            `viewport=${debugInfo.viewportWidth.toFixed(2)}x${debugInfo.viewportHeight.toFixed(2)}`,
            `raw=${debugInfo.rawPageWidth.toFixed(2)}x${debugInfo.rawPageHeight.toFixed(2)} userUnit=${debugInfo.userUnit}`,
            `totalScale=${debugInfo.totalScaleFactor.toFixed(10)} cssVarTotal=${JSON.stringify(computedTotalScaleFactor)}`,
            `canvasPx=${debugInfo.canvasPixelWidth}x${debugInfo.canvasPixelHeight} renderScale=${debugInfo.renderScaleX.toFixed(6)}x${debugInfo.renderScaleY.toFixed(6)}`,
        ];
    }

    function buildHighlightDebugMessage(
        pageNumber: number,
        guard: IHighlightDebugGuard,
        rects: IHighlightDebugRects,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const dx = rects.textRect.left - rects.canvasRect.left;
        const dy = rects.textRect.top - rects.canvasRect.top;
        const dw = rects.textRect.width - rects.canvasRect.width;
        const dh = rects.textRect.height - rects.canvasRect.height;
        const [
            viewportInfo,
            rawInfo,
            totalScaleInfo,
            canvasPixelInfo,
        ] = formatHighlightDebugInfo(debugInfo, rects.computedTotalScaleFactor);

        return [
            `page=${pageNumber}`,
            `matchIndex=${guard.current.matchIndex}`,
            `scale=${guard.scale}`,
            `query=${JSON.stringify(guard.query)}`,
            viewportInfo,
            rawInfo,
            totalScaleInfo,
            canvasPixelInfo,
            rects.containerRect ? `container=${formatHighlightDebugRect(rects.containerRect)}` : '',
            rects.canvasHostRect ? `canvasHost=${formatHighlightDebugRect(rects.canvasHostRect)}` : '',
            `canvas=${formatHighlightDebugRect(rects.canvasRect)}`,
            `textLayer=${formatHighlightDebugRect(rects.textRect)}`,
            `delta=${dx.toFixed(2)},${dy.toFixed(2)} ${dw.toFixed(2)}x${dh.toFixed(2)}`,
            rects.highlightRect ? `currentHighlight=${formatHighlightDebugRect(rects.highlightRect)}` : 'currentHighlight=null',
            rects.currentSpanInfo,
        ].join(' ');
    }

    function maybeLogHighlightDebug(
        pageNumber: number,
        pageMatchData: IPdfPageMatches | null,
        canvas: HTMLCanvasElement,
        textLayerDiv: HTMLElement,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const guard = getHighlightDebugGuard(pageNumber, pageMatchData);
        if (!guard) {
            return;
        }

        BrowserLogger.debug(
            'PDF-HIGHLIGHT',
            buildHighlightDebugMessage(
                pageNumber,
                guard,
                collectHighlightDebugRects(canvas, textLayerDiv),
                debugInfo,
            ),
        );
    }

    async function renderTextLayer(
        pdfPage: PDFPageProxy,
        textLayerDiv: HTMLElement,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        scale: number,
        userUnit: number,
        totalScaleFactor: number,
    ) {
        clearTextLayerIndexCache(textLayerDiv);
        textLayerDiv.innerHTML = '';
        textLayerDiv.style.setProperty('--scale-factor', String(scale));
        textLayerDiv.style.setProperty('--user-unit', String(userUnit));
        textLayerDiv.style.setProperty('--total-scale-factor', String(totalScaleFactor));

        const currentWorkingCopyPath = toValue(deps.workingCopyPath);
        let textContent = null;

        if (currentWorkingCopyPath) {
            try {
                const ocrTextContent = await getOcrTextContent(
                    currentWorkingCopyPath,
                    pdfPage.pageNumber,
                    viewport,
                );
                if (ocrTextContent) {
                    textContent = ocrTextContent;
                }
            } catch (ocrError) {
                BrowserLogger.warn('pdf-text-layer', 'OCR text content failed', ocrError);
            }
        }

        if (!textContent) {
            textContent = await pdfPage.getTextContent({
                includeMarkedContent: true,
                disableNormalization: true,
            });
        }

        const textLayer = new TextLayer({
            textContentSource: textContent,
            container: textLayerDiv,
            viewport,
        });
        await textLayer.render();
        textLayerDiv.style.width = '';
        textLayerDiv.style.height = '';
    }

    function setupTextLayerInteraction(textLayerDiv: HTMLElement) {
        return setupTextLayer(textLayerDiv);
    }

    function applyPageSearchHighlights(
        container: HTMLElement,
        textLayerDiv: HTMLElement,
        pageNumber: number,
        canvas: HTMLCanvasElement | null,
        debugInfo?: IHighlightDebugInfo,
    ) {
        const pageIndex = pageNumber - 1;
        const searchMatches = toValue(deps.searchPageMatches);
        const currentMatch = toValue(deps.currentSearchMatch) ?? null;
        if (!searchMatches || searchMatches.size === 0) {
            clearWordBoxes(container);
            pageHighlightState.signatureByPage.set(pageNumber, buildPageHighlightSignature(null, currentMatch));
            return;
        }

        const pageMatchData = searchMatches.get(pageIndex) ?? null;
        const signature = buildPageHighlightSignature(pageMatchData, currentMatch);
        const highlightResult = highlightPage(
            textLayerDiv,
            pageMatchData,
            currentMatch,
        );
        if (canvas) {
            maybeLogHighlightDebug(pageNumber, pageMatchData, canvas, textLayerDiv, debugInfo);
        }

        const isCssHighlightMode = getHighlightMode() === 'css';
        const hasInTextHighlights = isCssHighlightMode
            || highlightResult.elements.length > 0
            || highlightResult.currentMatchRanges.length > 0;

        if (!hasInTextHighlights && pageMatchData && pageMatchData.matches.length > 0) {
            renderWordBoxesForPageMatch(container, pageMatchData, currentMatch, pageIndex);
        } else {
            clearWordBoxes(container);
        }

        pageHighlightState.signatureByPage.set(pageNumber, signature);
    }

    function applyAllSearchHighlights(containerRoot: HTMLElement) {
        scheduleSearchHighlightRefresh(containerRoot);
    }

    function scrollToCurrentMatch(containerRoot: HTMLElement) {
        function clampScrollTopToTargetPage(
            desiredTop: number,
            targetPageContainer: HTMLElement,
        ) {
            const computedStyle = typeof window !== 'undefined'
                ? window.getComputedStyle(containerRoot)
                : null;
            const paddingTop = Number.parseFloat(computedStyle?.paddingTop ?? '0') || 0;
            const paddingBottom = Number.parseFloat(computedStyle?.paddingBottom ?? '0') || 0;

            const minTop = Math.max(0, targetPageContainer.offsetTop - paddingTop);
            const pageBottom = targetPageContainer.offsetTop + targetPageContainer.offsetHeight + paddingBottom;
            const maxTop = Math.max(minTop, pageBottom - containerRoot.clientHeight);
            const clampedTop = Math.min(maxTop, Math.max(minTop, desiredTop));

            return {
                clampedTop,
                minTop,
                maxTop,
                paddingTop,
                paddingBottom,
            };
        }

        function scrollMatchRectIntoView(
            rect: DOMRect,
            targetPageContainer: HTMLElement,
            source: 'range' | 'mark',
        ) {
            const containerRect = containerRoot.getBoundingClientRect();
            const elementTop = rect.top - containerRect.top + containerRoot.scrollTop;
            const desiredTop = elementTop - containerRoot.clientHeight / 2 + rect.height / 2;
            const {
                clampedTop,
                minTop,
                maxTop,
                paddingTop,
                paddingBottom,
            } = clampScrollTopToTargetPage(desiredTop, targetPageContainer);

            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch (${source}): scrollTop=${containerRoot.scrollTop.toFixed(1)}`
                + ` rect.top=${rect.top.toFixed(1)} containerRect.top=${containerRect.top.toFixed(1)}`
                + ` elementTop=${elementTop.toFixed(1)} desiredTop=${desiredTop.toFixed(1)}`
                + ` clampedTop=${clampedTop.toFixed(1)} pageMin=${minTop.toFixed(1)}`
                + ` pageMax=${maxTop.toFixed(1)} padTop=${paddingTop.toFixed(1)}`
                + ` padBottom=${paddingBottom.toFixed(1)}`,
            );

            containerRoot.scrollTop = clampedTop;
        }

        const currentMatchValue = toValue(deps.currentSearchMatch);
        if (!currentMatchValue) {
            logPdfNav('[PDF-NAV] scrollToCurrentMatch: no current search match');
            return false;
        }

        const pageIndex = currentMatchValue.pageIndex;
        const targetContainer = getPageContainer(containerRoot, pageIndex);

        if (!targetContainer) {
            const mountedPages = Array.from(
                containerRoot.querySelectorAll<HTMLElement>('.page_container'),
            )
                .map(page => page.dataset.page ?? '?')
                .slice(0, 20)
                .join(',');
            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch: target page=${pageIndex + 1} not mounted`
                + ` mountedPages=[${mountedPages}]`,
            );
            return false;
        }

        const textLayerDiv = targetContainer.querySelector<HTMLElement>('.text-layer');
        if (!textLayerDiv) {
            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} has no text-layer`,
            );
            return false;
        }

        const currentHighlight = textLayerDiv.querySelector<HTMLElement>('.pdf-search-highlight--current');
        if (!currentHighlight) {
            const currentRanges = getCurrentMatchRanges(textLayerDiv);
            const range = currentRanges.at(0) ?? null;
            if (!range) {
                logPdfNav(
                    `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} no current highlight and no ranges`,
                );
                return false;
            }

            const rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                logPdfNav(
                    `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} range rect empty`,
                );
                return false;
            }

            scrollMatchRectIntoView(rect, targetContainer, 'range');
            return true;
        }

        const highlightRect = currentHighlight.getBoundingClientRect();
        if (highlightRect.width === 0 && highlightRect.height === 0) {
            logPdfNav(
                `[PDF-NAV] scrollToCurrentMatch: page=${pageIndex + 1} current highlight rect empty`,
            );
            return false;
        }

        scrollMatchRectIntoView(highlightRect, targetContainer, 'mark');
        return true;
    }

    function cleanupTextLayerDom(textLayerDiv: HTMLElement) {
        clearHighlights(textLayerDiv);
        textLayerDiv.innerHTML = '';
        clearTextLayerIndexCache(textLayerDiv);

        const pageContainer = textLayerDiv.closest<HTMLElement>('.page_container');
        const pageNumber = Number.parseInt(pageContainer?.dataset.page ?? '', 10);
        if (Number.isFinite(pageNumber) && pageNumber > 0) {
            pageHighlightState.signatureByPage.delete(pageNumber);
        }
    }

    function clearOcrDebug(container: HTMLElement) {
        clearOcrDebugBoxes(container);
    }

    function scheduleRenderOcrDebugBoxes(
        container: HTMLElement,
        pageNumber: number,
        wcPath: string,
        viewport: ReturnType<PDFPageProxy['getViewport']>,
        rawPageWidth: number,
        rawPageHeight: number,
    ) {
        guardAsync(
            renderOcrDebugBoxes(
                container,
                pageNumber,
                wcPath,
                viewport,
                rawPageWidth,
                rawPageHeight,
            ),
            {
                scope: 'pdf-renderer',
                message: `Failed to render OCR debug overlays for page ${pageNumber}`,
            },
        );
    }

    function scheduleOcrDebugForPage(
        pageNumber: number,
        context: {
            container: HTMLElement;
            renderResult: {
                viewport: ReturnType<PDFPageProxy['getViewport']>;
                rawDims: {
                    pageWidth: number;
                    pageHeight: number;
                };
            };
        },
    ) {
        if (!isOcrDebugEnabled()) {
            return;
        }

        const wcPath = toValue(deps.workingCopyPath);
        if (!wcPath) {
            return;
        }

        const {
            viewport,
            rawDims,
        } = context.renderResult;
        scheduleRenderOcrDebugBoxes(
            context.container,
            pageNumber,
            wcPath,
            viewport,
            rawDims.pageWidth,
            rawDims.pageHeight,
        );
    }

    return {
        renderTextLayer,
        setupTextLayerInteraction,
        applyPageSearchHighlights,
        applyAllSearchHighlights,
        scrollToCurrentMatch,
        cleanupTextLayerDom,
        clearOcrDebug,
        isOcrDebugEnabled,
        renderOcrDebugBoxes,
        scheduleRenderOcrDebugBoxes,
        scheduleOcrDebugForPage,
        getCurrentMatchRanges,
    };
};
