export type TAnnotationSyncEvent<T> =
    | {
        type: 'begin';
        generation: number
    }
    | {
        type: 'receive-editor-snapshot';
        generation: number;
        records: readonly T[]
    }
    | {
        type: 'receive-pdf-page';
        generation: number;
        pageIndex: number;
        records: readonly T[]
    }
    | {
        type: 'finish-pdf-snapshot';
        generation: number
    }
    | {
        type: 'editor-layer-rebuilt';
        generation: number;
        pageIndex: number
    }
    | {
        type: 'suppress';
        generation: number;
        token: string
    };

export interface IAnnotationSyncState<T> {
    readonly generation: number;
    readonly phase: 'idle' | 'collecting' | 'complete';
    readonly editorRecords: readonly T[];
    readonly pdfPages: ReadonlyMap<number, readonly T[]>;
    readonly rebuiltPages: ReadonlySet<number>;
    readonly suppressedTokens: ReadonlySet<string>;
}

export function initialAnnotationSyncState<T>(): IAnnotationSyncState<T> {
    return {
        generation: 0,
        phase: 'idle',
        editorRecords: [],
        pdfPages: new Map(),
        rebuiltPages: new Set(),
        suppressedTokens: new Set(),
    };
}

export function reduceAnnotationSync<T>(
    state: IAnnotationSyncState<T>,
    event: TAnnotationSyncEvent<T>,
): IAnnotationSyncState<T> {
    if (event.type === 'begin') {
        if (event.generation <= state.generation) {
            return state;
        }
        return {
            ...initialAnnotationSyncState<T>(),
            generation: event.generation,
            phase: 'collecting',
        };
    }
    if (event.generation !== state.generation || state.phase !== 'collecting') {
        return state;
    }
    if (event.type === 'receive-editor-snapshot') {
        return {
            ...state,
            editorRecords: [...event.records],
        };
    }
    if (event.type === 'receive-pdf-page') {
        if (!Number.isInteger(event.pageIndex) || event.pageIndex < 0) {
            return state;
        }
        const pdfPages = new Map(state.pdfPages);
        pdfPages.set(event.pageIndex, [...event.records]);
        return {
            ...state,
            pdfPages,
        };
    }
    if (event.type === 'editor-layer-rebuilt') {
        return {
            ...state,
            rebuiltPages: new Set(state.rebuiltPages).add(event.pageIndex),
        };
    }
    if (event.type === 'suppress') {
        return {
            ...state,
            suppressedTokens: new Set(state.suppressedTokens).add(event.token),
        };
    }
    return {
        ...state,
        phase: 'complete',
    };
}
