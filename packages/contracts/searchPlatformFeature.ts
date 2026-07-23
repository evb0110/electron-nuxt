/* eslint-disable @stylistic/object-curly-newline, @stylistic/object-property-newline */
import {
    SEARCH_WIRE_CODEC,
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
    type IPdfSearchProgress,
    type IPdfSearchRequestOptions,
    type IPdfSearchResult,
} from '@contracts/search';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
function decodeSearchProgress(payload: unknown): IPdfSearchProgress | null {
    if (!isRecord(payload) || typeof payload.requestId !== 'string'
        || !isFiniteNumber(payload.processed) || !isFiniteNumber(payload.total)
        || (payload.truncated !== undefined && typeof payload.truncated !== 'boolean')
        || (payload.canceled !== undefined && typeof payload.canceled !== 'boolean')
        || (payload.status !== undefined && payload.status !== 'running' && payload.status !== 'success'
            && payload.status !== 'canceled' && payload.status !== 'failed')
        || (payload.error !== undefined && typeof payload.error !== 'string')) {
        return null;
    }
    const base: IPdfSearchProgress = {
        requestId: payload.requestId,
        processed: payload.processed,
        total: payload.total,
        ...(payload.truncated === undefined ? {} : {truncated: payload.truncated}),
        ...(payload.canceled === undefined ? {} : {canceled: payload.canceled}),
        ...(payload.status === undefined ? {} : {status: payload.status}),
        ...(payload.error === undefined ? {} : {error: payload.error}),
    };
    if (payload.results !== undefined) {
        const rawResultsStartIndex = payload.resultsStartIndex;
        if (!Array.isArray(payload.results)
            || (rawResultsStartIndex !== undefined && (!isFiniteNumber(rawResultsStartIndex)
                || !Number.isSafeInteger(rawResultsStartIndex) || rawResultsStartIndex < 0))) {
            return null;
        }
        const results = payload.results.map(result => SEARCH_WIRE_CODEC.decodeResult(result));
        if (results.some(result => result === null)) {
            return null;
        }
        return {
            ...base,
            results: results as IPdfSearchResult[],
            ...(rawResultsStartIndex === undefined ? {} : {resultsStartIndex: rawResultsStartIndex}),
        };
    }
    return base;
}
type TCancelArgs = [requestId?: string | undefined];
function decodeCancelArgs(value: unknown): TCancelArgs {
    if (!Array.isArray(value) || value.length > 1) {
        const length = Array.isArray(value) ? value.length : 0;
        throw new Error(`expected 0-1 arguments, received ${length}`);
    }
    const requestId = normalizeOptionalSearchRequestId(value[0]);
    return requestId === undefined ? [] : [requestId];
}
function decodeCancelResult(value: unknown) {
    if (!isRecord(value) || typeof value.canceled !== 'boolean') {
        throw new Error('invalid search cancellation result');
    }
    return {canceled: value.canceled};
}
const noArgs = s.tuple([]);
const booleanResult = s.boolean(true);
const searchRequest = s.fromParser(normalizePdfSearchRequestPayload,
    () => ({pdfPath: '/tmp/fixture.pdf', query: 'needle'}));
const warmIndexRequest = s.fromParser(normalizePdfSearchWarmIndexPayload,
    () => ({pdfPath: '/tmp/fixture.pdf'}));
const searchResponse = s.fromNullableDecoder(SEARCH_WIRE_CODEC.decodeResponse,
    'search response', () => ({results: [], truncated: false}));
const searchProgress = s.declared<IPdfSearchProgress>()(
    s.fromNullableDecoder(decodeSearchProgress, 'search progress', () => ({
        requestId: 'search-fixture', processed: 0, total: 1, status: 'running',
    })),
);
const cancelArgs = {decode: decodeCancelArgs,
    encode: (value: TCancelArgs): TCancelArgs => [normalizeOptionalSearchRequestId(value[0])],
    example: (): TCancelArgs => ['search-fixture']};
export const SEARCH_PLATFORM_FEATURE = definePlatformFeature({
    path: ['search'],
    required: {browser: true, electron: true},
    methods: {
        run: {
            kind: 'async', channel: 'pdf:search',
            ipc: {args: s.tuple([searchRequest]), result: searchResponse, timeoutMs: 30 * 60 * 1_000},
            client: {mapArgs: (
                pdfPath: string, query: string, options?: IPdfSearchRequestOptions,
            ) => [normalizePdfSearchRequestPayload({pdfPath, query, ...options})]},
            main: {method: 'run', context: 'sender'}, browser: {method: 'run'}, lazy: 'forwarded',
        },
        warmIndex: {
            kind: 'async', channel: 'pdf:search:warmIndex',
            ipc: {args: s.tuple([warmIndexRequest]), result: booleanResult, timeoutMs: 30 * 60 * 1_000},
            client: {mapArgs: (
                pdfPath: string, options?: IPdfSearchRequestOptions,
            ) => [normalizePdfSearchWarmIndexPayload({pdfPath, ...options})]},
            main: {method: 'warmIndex', context: 'sender'}, browser: {method: 'warmIndex'}, lazy: 'forwarded',
        },
        cancel: {
            kind: 'async', channel: 'pdf:search:cancel',
            ipc: {args: cancelArgs, result: s.fromParser(decodeCancelResult, () => ({canceled: false}))},
            client: {mapArgs: (requestId?: string): TCancelArgs =>
                [normalizeOptionalSearchRequestId(requestId)]},
            main: {method: 'cancel', context: 'sender'}, browser: {method: 'cancel'}, lazy: 'forwarded',
        },
        resetCache: {
            kind: 'async', channel: 'pdf:search:resetCache',
            ipc: {args: noArgs, result: booleanResult},
            main: {method: 'resetCache', context: 'none'}, browser: {method: 'resetCache'}, lazy: 'forwarded',
        },
    },
    events: {onProgress: {
        kind: 'event', channel: 'pdf:search:progress', payload: searchProgress,
        subscription: {
            channel: 'pdf:search:progress:subscribe', request: 'once-per-preload-event-channel',
            main: {method: 'subscribeProgress', context: 'sender'},
            replay: {
                owner: 'ipc-progress-pump', mode: 'latest-per-key',
                key: (progress: IPdfSearchProgress) => progress.requestId,
                terminal: (progress: IPdfSearchProgress) => progress.status === 'success'
                        || progress.status === 'canceled'
                        || progress.status === 'failed'
                        || progress.canceled === true
                        || progress.processed >= progress.total,
                intervalMs: 50, terminalRetentionMs: 30_000,
            },
        },
        browser: {method: 'onProgress'}, lazy: 'forwarded',
    }},
});
export type ISearchCapability = TFeatureCapability<typeof SEARCH_PLATFORM_FEATURE>;
export type ISearchInvokeMap = TFeatureInvokeMap<typeof SEARCH_PLATFORM_FEATURE>;
export type ISearchEventMap = TFeatureEventMap<typeof SEARCH_PLATFORM_FEATURE>;
