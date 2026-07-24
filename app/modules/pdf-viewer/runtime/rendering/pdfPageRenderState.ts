type TPdfPageRenderVisualState = 'none' | 'ready';
type TPdfPageRenderJobState = 'idle' | 'rendering' | 'failed';
type TPdfPageCanvasReadiness = 'none' | 'ready';
export type TPdfPageLayerReadiness = 'none' | 'canvas-only' | 'hydrating' | 'ready';

export interface IPdfCommittedRasterQuality {
    readonly requestedPixels: number;
    readonly grantedPixels: number;
    readonly pixelScaleFactor: number;
    readonly wasClamped: boolean;
    readonly intent: 'buffer-preview' | 'settled';
}

export function resolvePdfCommittedRasterQuality(
    renderResult: {
        canvas: Pick<HTMLCanvasElement, 'height' | 'width'>;
        grantedPixels?: number;
        pixelScaleFactor?: number;
        requestedPixels?: number;
        wasClamped?: boolean;
    },
    intent: IPdfCommittedRasterQuality['intent'],
): IPdfCommittedRasterQuality {
    const fallbackPixels = Math.max(0, renderResult.canvas.width * renderResult.canvas.height);
    const hasQuality = Number.isFinite(renderResult.requestedPixels)
        && Number.isFinite(renderResult.grantedPixels)
        && Number.isFinite(renderResult.pixelScaleFactor)
        && typeof renderResult.wasClamped === 'boolean';
    return {
        requestedPixels: hasQuality ? renderResult.requestedPixels! : fallbackPixels,
        grantedPixels: hasQuality ? renderResult.grantedPixels! : fallbackPixels,
        pixelScaleFactor: hasQuality ? renderResult.pixelScaleFactor! : 1,
        wasClamped: hasQuality ? renderResult.wasClamped! : false,
        intent,
    };
}

interface IPdfPageRenderSlot {
    readonly visual: TPdfPageRenderVisualState;
    readonly canvasReadiness: TPdfPageCanvasReadiness;
    readonly layerReadiness: TPdfPageLayerReadiness;
    readonly job: TPdfPageRenderJobState;
    readonly version: number | null;
    readonly contentVersion: number | null;
    readonly requestId: number | null;
    readonly documentToken: string | null;
    readonly targetScale: number | null;
    readonly targetOutputScale: number | null;
    readonly container: HTMLElement | null;
    readonly committedRasterQuality: IPdfCommittedRasterQuality | null;
    readonly pendingDocumentToken: string | null;
    readonly pendingTargetScale: number | null;
    readonly pendingTargetOutputScale: number | null;
    readonly pendingContainer: HTMLElement | null;
}

export interface IPdfPageNumberStateSet extends Iterable<number> {
    readonly size: number;
    add: (pageNumber: number) => IPdfPageNumberStateSet;
    clear: () => void;
    delete: (pageNumber: number) => boolean;
    entries: () => SetIterator<[number, number]>;
    forEach: (callback: (value: number) => void) => void;
    has: (pageNumber: number) => boolean;
    keys: () => SetIterator<number>;
    values: () => SetIterator<number>;
}

export interface IPdfPageNumberStateMap extends Iterable<[number, number]> {
    readonly size: number;
    clear: () => void;
    delete: (pageNumber: number) => boolean;
    entries: () => MapIterator<[number, number]>;
    forEach: (callback: (value: number, key: number) => void) => void;
    get: (pageNumber: number) => number | undefined;
    has: (pageNumber: number) => boolean;
    keys: () => MapIterator<number>;
    set: (pageNumber: number, value: number) => IPdfPageNumberStateMap;
    values: () => MapIterator<number>;
}

const EMPTY_RENDER_SLOT: IPdfPageRenderSlot = {
    visual: 'none',
    canvasReadiness: 'none',
    layerReadiness: 'none',
    job: 'idle',
    version: null,
    contentVersion: null,
    requestId: null,
    documentToken: null,
    targetScale: null,
    targetOutputScale: null,
    container: null,
    committedRasterQuality: null,
    pendingDocumentToken: null,
    pendingTargetScale: null,
    pendingTargetOutputScale: null,
    pendingContainer: null,
};

export function createPdfPageRenderState() {
    const slots = new Map<number, IPdfPageRenderSlot>();

    function getSlot(pageNumber: number) {
        return slots.get(pageNumber) ?? EMPTY_RENDER_SLOT;
    }

    function setSlot(pageNumber: number, slot: IPdfPageRenderSlot) {
        if (
            slot.canvasReadiness === 'none'
            && slot.layerReadiness === 'none'
            && slot.job === 'idle'
        ) {
            slots.delete(pageNumber);
            return;
        }
        slots.set(pageNumber, slot);
    }

    function updateSlot(pageNumber: number, patch: Partial<IPdfPageRenderSlot>) {
        setSlot(pageNumber, {
            ...getSlot(pageNumber),
            ...patch,
        });
    }

    function createSetView(options: {
        includes: (slot: IPdfPageRenderSlot) => boolean;
        add: (pageNumber: number) => void;
        remove: (pageNumber: number) => void;
    }): IPdfPageNumberStateSet {
        const pageNumbers = () => [...slots]
            .filter(([
                , slot,
            ]) => options.includes(slot))
            .map(([pageNumber]) => pageNumber);
        const view: IPdfPageNumberStateSet = {
            get size() {
                return pageNumbers().length;
            },
            add(pageNumber) {
                options.add(pageNumber);
                return view;
            },
            clear() {
                pageNumbers().forEach(options.remove);
            },
            delete(pageNumber) {
                if (!view.has(pageNumber)) {
                    return false;
                }
                options.remove(pageNumber);
                return true;
            },
            entries() {
                return new Set(pageNumbers()).entries();
            },
            forEach(callback) {
                pageNumbers().forEach(pageNumber => callback(pageNumber));
            },
            has(pageNumber) {
                return options.includes(getSlot(pageNumber));
            },
            keys() {
                return new Set(pageNumbers()).keys();
            },
            values() {
                return new Set(pageNumbers()).values();
            },
            [Symbol.iterator]() {
                return view.values();
            },
        };
        return view;
    }

    function createMapView(options: {
        getValue: (slot: IPdfPageRenderSlot) => number | null;
        setValue: (pageNumber: number, value: number) => void;
        remove: (pageNumber: number) => void;
    }): IPdfPageNumberStateMap {
        const entries = () => [...slots]
            .map(([
                pageNumber,
                slot,
            ]) => [
                pageNumber,
                options.getValue(slot),
            ] as const)
            .filter((entry): entry is readonly [number, number] => entry[1] !== null);
        const view: IPdfPageNumberStateMap = {
            get size() {
                return entries().length;
            },
            clear() {
                entries().forEach(([pageNumber]) => options.remove(pageNumber));
            },
            delete(pageNumber) {
                if (!view.has(pageNumber)) {
                    return false;
                }
                options.remove(pageNumber);
                return true;
            },
            entries() {
                return new Map(entries()).entries();
            },
            forEach(callback) {
                entries().forEach(([
                    pageNumber,
                    value,
                ]) => callback(value, pageNumber));
            },
            get(pageNumber) {
                return options.getValue(getSlot(pageNumber)) ?? undefined;
            },
            has(pageNumber) {
                return options.getValue(getSlot(pageNumber)) !== null;
            },
            keys() {
                return new Map(entries()).keys();
            },
            set(pageNumber, value) {
                options.setValue(pageNumber, value);
                return view;
            },
            values() {
                return new Map(entries()).values();
            },
            [Symbol.iterator]() {
                return view.entries();
            },
        };
        return view;
    }

    const renderedPages = createSetView({
        includes: slot => slot.canvasReadiness === 'ready',
        add: pageNumber => updateSlot(pageNumber, {
            visual: 'ready',
            canvasReadiness: 'ready',
        }),
        remove: pageNumber => updateSlot(pageNumber, {
            visual: 'none',
            canvasReadiness: 'none',
            layerReadiness: 'none',
        }),
    });
    const renderingPages = createMapView({
        getValue: slot => slot.job === 'rendering' ? slot.version : null,
        setValue: (pageNumber, version) => updateSlot(pageNumber, {
            job: 'rendering',
            version,
        }),
        remove: pageNumber => updateSlot(pageNumber, {
            job: 'idle',
            version: null,
            requestId: null,
            pendingDocumentToken: null,
            pendingTargetScale: null,
            pendingTargetOutputScale: null,
            pendingContainer: null,
        }),
    });
    const renderingPageRequestIds = createMapView({
        getValue: slot => slot.job === 'rendering' ? slot.requestId : null,
        setValue: (pageNumber, requestId) => updateSlot(pageNumber, {
            job: 'rendering',
            requestId,
        }),
        remove: pageNumber => updateSlot(pageNumber, {
            job: 'idle',
            version: null,
            requestId: null,
            pendingDocumentToken: null,
            pendingTargetScale: null,
            pendingTargetOutputScale: null,
            pendingContainer: null,
        }),
    });

    return {
        slots: slots as ReadonlyMap<number, IPdfPageRenderSlot>,
        renderedPages,
        renderingPages,
        renderingPageRequestIds,
        getSlot,
        markRenderFailed(pageNumber: number, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                job: 'failed',
                version,
                requestId,
            });
            return true;
        },
        beginRender(
            pageNumber: number,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
            targetOutputScale = 1,
            container: HTMLElement | null = null,
            beginOptions: {preserveCommittedVisual?: boolean} = {},
        ) {
            const current = getSlot(pageNumber);
            const preserveCommittedVisual = beginOptions.preserveCommittedVisual === true
                && current.canvasReadiness === 'ready'
                && current.container === container;
            updateSlot(pageNumber, {
                visual: preserveCommittedVisual ? 'ready' : 'none',
                canvasReadiness: preserveCommittedVisual ? 'ready' : 'none',
                layerReadiness: preserveCommittedVisual ? current.layerReadiness : 'none',
                job: 'rendering',
                version,
                contentVersion: preserveCommittedVisual ? current.contentVersion : version,
                requestId,
                documentToken: preserveCommittedVisual ? current.documentToken : documentToken,
                targetScale: preserveCommittedVisual ? current.targetScale : targetScale,
                targetOutputScale: preserveCommittedVisual
                    ? current.targetOutputScale
                    : targetOutputScale,
                committedRasterQuality: preserveCommittedVisual
                    ? current.committedRasterQuality
                    : null,
                container: preserveCommittedVisual ? current.container : container,
                pendingDocumentToken: documentToken,
                pendingTargetScale: targetScale,
                pendingTargetOutputScale: targetOutputScale,
                pendingContainer: container,
            });
        },
        beginQualityRefine(
            pageNumber: number,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
            targetOutputScale = 1,
            container: HTMLElement | null = getSlot(pageNumber).container,
        ) {
            this.beginRender(
                pageNumber,
                version,
                requestId,
                documentToken,
                targetScale,
                targetOutputScale,
                container,
                {preserveCommittedVisual: true},
            );
        },
        commitVisual(
            pageNumber: number,
            version: number,
            requestId: number,
            committedRasterQuality: IPdfCommittedRasterQuality = {
                requestedPixels: 0,
                grantedPixels: 0,
                pixelScaleFactor: 1,
                wasClamped: false,
                intent: 'settled',
            },
        ) {
            const current = getSlot(pageNumber);
            if (current.job !== 'rendering' || current.version !== version || current.requestId !== requestId) {
                return false;
            }
            updateSlot(pageNumber, {
                visual: 'ready',
                canvasReadiness: 'ready',
                contentVersion: version,
                documentToken: current.pendingDocumentToken,
                targetScale: current.pendingTargetScale,
                targetOutputScale: current.pendingTargetOutputScale,
                container: current.pendingContainer,
                committedRasterQuality,
            });
            return true;
        },
        markCanvasOnly(pageNumber: number, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
                || current.canvasReadiness !== 'ready'
            ) {
                return false;
            }
            updateSlot(pageNumber, {layerReadiness: 'canvas-only'});
            return true;
        },
        beginLayerHydration(
            pageNumber: number,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
            targetOutputScale: number,
            container: HTMLElement,
        ) {
            const current = getSlot(pageNumber);
            if (
                current.canvasReadiness !== 'ready'
                || current.documentToken !== documentToken
                || current.contentVersion !== version
                || current.targetScale !== targetScale
                || current.targetOutputScale !== targetOutputScale
                || current.container !== container
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'hydrating',
                job: 'rendering',
                version,
                requestId,
            });
            return true;
        },
        markLayersHydrating(pageNumber: number, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
                || current.canvasReadiness !== 'ready'
            ) {
                return false;
            }
            updateSlot(pageNumber, {layerReadiness: 'hydrating'});
            return true;
        },
        markLayersReady(pageNumber: number, contentVersion: number, container: HTMLElement) {
            const current = getSlot(pageNumber);
            if (
                current.canvasReadiness !== 'ready'
                || current.contentVersion !== contentVersion
                || current.container !== container
            ) {
                return false;
            }
            updateSlot(pageNumber, {layerReadiness: 'ready'});
            return true;
        },
        failLayerHydration(pageNumber: number, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (
                current.job !== 'rendering'
                || current.version !== version
                || current.requestId !== requestId
                || current.canvasReadiness !== 'ready'
            ) {
                return false;
            }
            updateSlot(pageNumber, {
                layerReadiness: 'canvas-only',
                job: 'idle',
                version: null,
                requestId: null,
                pendingDocumentToken: null,
                pendingTargetScale: null,
                pendingTargetOutputScale: null,
                pendingContainer: null,
            });
            return true;
        },
        completeRender(pageNumber: number, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (current.job !== 'rendering' || current.version !== version || current.requestId !== requestId) {
                return false;
            }
            updateSlot(pageNumber, {
                job: 'idle',
                version: null,
                requestId: null,
                pendingDocumentToken: null,
                pendingTargetScale: null,
                pendingTargetOutputScale: null,
                pendingContainer: null,
            });
            return true;
        },
        adoptCommittedCanvasVersion(pageNumber: number, contentVersion: number) {
            const current = getSlot(pageNumber);
            if (current.canvasReadiness !== 'ready') {
                return false;
            }
            updateSlot(pageNumber, {
                contentVersion,
                layerReadiness: current.layerReadiness === 'hydrating'
                    ? 'canvas-only'
                    : current.layerReadiness,
                job: 'idle',
                version: null,
                requestId: null,
                pendingDocumentToken: null,
                pendingTargetScale: null,
                pendingTargetOutputScale: null,
                pendingContainer: null,
            });
            return true;
        },
        commitCanvas(
            pageNumber: number,
            version: number,
            requestId: number,
            committedRasterQuality?: IPdfCommittedRasterQuality,
        ) {
            if (!this.commitVisual(pageNumber, version, requestId, committedRasterQuality)) {
                return false;
            }
            return this.completeRender(pageNumber, version, requestId);
        },
        clearPage(pageNumber: number) {
            slots.delete(pageNumber);
        },
        clearAll() {
            slots.clear();
        },
    };
}

export type TPdfPageRenderState = ReturnType<typeof createPdfPageRenderState>;
