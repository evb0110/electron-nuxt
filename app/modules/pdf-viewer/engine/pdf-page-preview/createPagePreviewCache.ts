import type {
    IPdfPagePreviewEntry,
    TPdfPagePreviewSource,
} from '@app/modules/pdf-viewer/engine/pdf-page-preview/pdfPagePreviewTypes';

interface ICreatePagePreviewCacheOptions {
    maxEntries: number;
    onChange?: (() => void) | undefined;
}

function normalizeMaxEntries(value: number) {
    return Number.isFinite(value) && value > 0
        ? Math.max(1, Math.trunc(value))
        : 1;
}

function isCanvasSource(source: TPdfPagePreviewSource): source is HTMLCanvasElement {
    return typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement;
}

export function closePagePreviewSource(source: TPdfPagePreviewSource) {
    if ('close' in source && typeof source.close === 'function') {
        source.close();
        return;
    }

    if (isCanvasSource(source)) {
        source.width = 0;
        source.height = 0;
        source.remove();
    }
}

export function createPagePreviewCache(options: ICreatePagePreviewCacheOptions) {
    const maxEntries = normalizeMaxEntries(options.maxEntries);
    const entries = new Map<number, IPdfPagePreviewEntry>();
    let nextEntryId = 1;

    function notifyChange() {
        options.onChange?.();
    }

    function deleteEntry(pageNumber: number) {
        const entry = entries.get(pageNumber);
        if (!entry) {
            return false;
        }

        entries.delete(pageNumber);
        closePagePreviewSource(entry.source);
        return true;
    }

    function evictOverflow() {
        while (entries.size > maxEntries) {
            const oldestPage = entries.keys().next().value;
            if (oldestPage === undefined) {
                return;
            }
            deleteEntry(oldestPage);
        }
    }

    function get(pageNumber: number, generation: number) {
        const entry = entries.get(pageNumber);
        if (!entry) {
            return null;
        }
        if (entry.generation !== generation) {
            deleteEntry(pageNumber);
            notifyChange();
            return null;
        }

        entries.delete(pageNumber);
        entries.set(pageNumber, entry);
        return entry;
    }

    function has(pageNumber: number, generation: number) {
        return get(pageNumber, generation) !== null;
    }

    function set(params: {
        pageNumber: number;
        source: TPdfPagePreviewSource;
        width: number;
        height: number;
        generation: number;
    }) {
        deleteEntry(params.pageNumber);
        const entry: IPdfPagePreviewEntry = {
            id: nextEntryId,
            pageNumber: params.pageNumber,
            source: params.source,
            width: params.width,
            height: params.height,
            generation: params.generation,
        };
        nextEntryId += 1;
        entries.set(params.pageNumber, entry);
        evictOverflow();
        notifyChange();
        return entry;
    }

    function deletePage(pageNumber: number) {
        if (deleteEntry(pageNumber)) {
            notifyChange();
        }
    }

    function clear() {
        if (entries.size === 0) {
            return;
        }

        for (const pageNumber of Array.from(entries.keys())) {
            deleteEntry(pageNumber);
        }
        notifyChange();
    }

    function size() {
        return entries.size;
    }

    return {
        get,
        has,
        set,
        deletePage,
        clear,
        size,
    };
}
