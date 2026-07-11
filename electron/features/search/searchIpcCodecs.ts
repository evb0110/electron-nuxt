import { SEARCH_WIRE_CODEC } from '@contracts/search';
import type { TIpcCodecMap } from '@contracts/ipcMain';
import { isRecord } from '@contracts/runtimeGuards';
import {
    normalizeOptionalSearchRequestId,
    normalizePdfSearchRequestPayload,
    normalizePdfSearchWarmIndexPayload,
} from '@electron/features/search/searchRequestPayload';
import {
    SEARCH_CHANNELS,
    type ISearchInvokeMap,
} from '@electron/features/search/contract';
import {
    decodeBooleanResult,
    decodeNoArgs,
    decodeUndefinedResult,
} from '@electron/platform-ipc/ipcCodecValidation';

function decodeSearchResponse(value: unknown) {
    const decoded = SEARCH_WIRE_CODEC.decodeResponse(value);
    if (decoded === null) {
        throw new Error('invalid search response');
    }
    return decoded;
}

function decodeCancelResult(value: unknown) {
    if (!isRecord(value) || typeof value.canceled !== 'boolean') {
        throw new Error('invalid search cancellation result');
    }
    return {canceled: value.canceled};
}

export const SEARCH_IPC_CODECS = {
    [SEARCH_CHANNELS.search]: {
        decodeArgs: (args: readonly unknown[]) => [normalizePdfSearchRequestPayload(args[0])],
        decodeResult: decodeSearchResponse,
    },
    [SEARCH_CHANNELS.warmIndex]: {
        decodeArgs: (args: readonly unknown[]) => [normalizePdfSearchWarmIndexPayload(args[0])],
        decodeResult: decodeBooleanResult,
    },
    [SEARCH_CHANNELS.cancel]: {
        decodeArgs: (args: readonly unknown[]) => {
            const requestId = normalizeOptionalSearchRequestId(args[0]);
            return requestId === undefined ? [] : [requestId];
        },
        decodeResult: decodeCancelResult,
    },
    [SEARCH_CHANNELS.resetCache]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeBooleanResult,
    },
    [SEARCH_CHANNELS.subscribeProgress]: {
        decodeArgs: decodeNoArgs,
        decodeResult: decodeUndefinedResult,
    },
} satisfies TIpcCodecMap<ISearchInvokeMap>;
