type TPdfPageRenderVisualState = 'none' | 'stale' | 'fresh';
type TPdfPageRenderJobState = 'idle' | 'rendering' | 'failed';

interface IPdfPageRenderSlot {
    readonly visual: TPdfPageRenderVisualState;
    readonly job: TPdfPageRenderJobState;
    readonly version: number | null;
    readonly requestId: number | null;
    readonly documentToken: string | null;
    readonly targetScale: number | null;
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
    job: 'idle',
    version: null,
    requestId: null,
    documentToken: null,
    targetScale: null,
};

export function createPdfPageRenderState() {
    const slots = new Map<number, IPdfPageRenderSlot>();

    function getSlot(pageNumber: number) {
        return slots.get(pageNumber) ?? EMPTY_RENDER_SLOT;
    }

    function setSlot(pageNumber: number, slot: IPdfPageRenderSlot) {
        if (slot.visual === 'none' && slot.job === 'idle') {
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
        includes: slot => slot.visual !== 'none',
        add: pageNumber => updateSlot(pageNumber, { visual: 'fresh' }),
        remove: pageNumber => updateSlot(pageNumber, { visual: 'none' }),
    });
    const staleRenderedPages = createSetView({
        includes: slot => slot.visual === 'stale',
        add: pageNumber => updateSlot(pageNumber, { visual: 'stale' }),
        remove: pageNumber => {
            if (getSlot(pageNumber).visual === 'stale') {
                updateSlot(pageNumber, { visual: 'fresh' });
            }
        },
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
        }),
    });

    return {
        slots: slots as ReadonlyMap<number, IPdfPageRenderSlot>,
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        getSlot,
        markRenderFailed(pageNumber: number, version: number, requestId: number) {
            updateSlot(pageNumber, {
                job: 'failed',
                version,
                requestId,
            });
        },
        beginRender(
            pageNumber: number,
            version: number,
            requestId: number,
            documentToken: string,
            targetScale: number,
        ) {
            const current = getSlot(pageNumber);
            const keepsPixels = current.visual !== 'none' && current.documentToken === documentToken;
            updateSlot(pageNumber, {
                visual: keepsPixels ? 'stale' : 'none',
                job: 'rendering',
                version,
                requestId,
                documentToken,
                targetScale,
            });
        },
        commitCanvas(pageNumber: number, version: number, requestId: number) {
            const current = getSlot(pageNumber);
            if (current.job !== 'rendering' || current.version !== version || current.requestId !== requestId) {
                return false;
            }
            updateSlot(pageNumber, {
                visual: 'fresh',
                job: 'idle',
                version: null,
                requestId: null,
            });
            return true;
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
