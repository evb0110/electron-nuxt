import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import {
    isDiagnosticCode,
    type DiagnosticCode,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import type {
    DiagnosticRecord,
    FailureSeverity,
} from '@contracts/diagnostics/diagnosticRecord';
import {isRecord} from '@contracts/runtimeGuards';
import type {
    IWindowCloseRequest,
    IWindowCloseResponse,
} from '@contracts/systemPlatformFeature';

export const CORE_IPC_CHANNELS = {rendererReady: 'app:rendererReady'} as const;

export const CORE_IPC_EVENT_CHANNELS = {
    menuCheckForUpdates: 'menu:checkForUpdates',
    debugLog: 'debug:log',
    shutdownSaveFlushRequest: 'shutdown:saveFlushRequest',
    windowCloseRequest: 'window:closeRequest',
} as const;

export const CORE_IPC_SEND_CHANNELS = {
    rendererDiagnostic: 'renderer:diagnostic',
    rendererLog: 'renderer:log',
    shutdownSaveFlushResult: 'shutdown:saveFlushResult',
    windowCloseResponse: 'window:closeResponse',
} as const;

export const DIAGNOSTICS_POLICY_ARGUMENT_PREFIX = '--evb-diagnostics-policy=';
export const DIAGNOSTICS_POLICY_HINTS = [
    'unknown',
    'granted',
    'denied',
] as const;

export type TDiagnosticsPolicyHint = typeof DIAGNOSTICS_POLICY_HINTS[number];

export interface IDiagnosticsStartupPolicy {mode: TDiagnosticsPolicyHint;}

export interface IDiagnosticsFailureRef {
    eventId: DiagnosticEventId;
    code: DiagnosticCode;
    severity: FailureSeverity;
}

export interface IDiagnosticsDebugLogEntry extends IDebugLogEntry {failureRef?: IDiagnosticsFailureRef;}

export interface IPreloadDiagnosticsApi {
    startupPolicy: Readonly<IDiagnosticsStartupPolicy>;
    sendRecord: (record: DiagnosticRecord) => void;
    onDebugLog: (callback: (entry: IDiagnosticsDebugLogEntry) => void) => () => void;
}

export interface ICoreEventMap {
    [CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates]: undefined;
    [CORE_IPC_EVENT_CHANNELS.debugLog]: IDebugLogEntry;
    [CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest]: IShutdownSaveFlushRequest;
    [CORE_IPC_EVENT_CHANNELS.windowCloseRequest]: IWindowCloseRequest;
}

function isDiagnosticsPolicyHint(value: unknown): value is TDiagnosticsPolicyHint {
    return typeof value === 'string'
        && (DIAGNOSTICS_POLICY_HINTS as readonly string[]).includes(value);
}

export function createDiagnosticsStartupPolicy(value: unknown): Readonly<IDiagnosticsStartupPolicy> {
    return Object.freeze({mode: isDiagnosticsPolicyHint(value) ? value : 'unknown'});
}

export function encodeDiagnosticsPolicyArgument(value: unknown) {
    const encoded = Buffer
        .from(JSON.stringify(createDiagnosticsStartupPolicy(value)), 'utf8')
        .toString('base64url');
    return `${DIAGNOSTICS_POLICY_ARGUMENT_PREFIX}${encoded}`;
}

export function decodeDiagnosticsDebugLogEntry(value: unknown): IDiagnosticsDebugLogEntry | null {
    if (!isRecord(value)
        || typeof value.source !== 'string'
        || typeof value.message !== 'string'
        || typeof value.timestamp !== 'string'
        || (value.level !== undefined
            && value.level !== 'DEBUG'
            && value.level !== 'INFO'
            && value.level !== 'WARN'
            && value.level !== 'ERROR')) {
        return null;
    }

    const failureRef = value.failureRef;
    if (failureRef !== undefined && (!isRecord(failureRef)
        || !isDiagnosticEventId(failureRef.eventId)
        || !isDiagnosticCode(failureRef.code)
        || (failureRef.severity !== 'error' && failureRef.severity !== 'fatal')
        || Reflect.ownKeys(failureRef).some(key => key !== 'eventId' && key !== 'code' && key !== 'severity'))) {
        return null;
    }
    const decodedFailureRef = failureRef as IDiagnosticsFailureRef | undefined;

    return {
        source: value.source,
        message: value.message,
        timestamp: value.timestamp,
        ...(value.level === undefined ? {} : {level: value.level}),
        ...(decodedFailureRef === undefined ? {} : {failureRef: decodedFailureRef}),
    };
}

export interface IShutdownSaveFlushRequest { requestId: string; }

export interface IShutdownSaveFlushResult {
    callbackCount: number;
    requestId: string;
    dirtyWorkingCopyPaths?: string[];
    error?: string;
    flushedWorkingCopyPaths?: string[];
}

function decodeShutdownPathList(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 1_024) {
        return null;
    }
    const paths = value.filter((path): path is string => (
        typeof path === 'string'
        && path.trim().length > 0
        && path.length <= 16_384
    ));
    return paths.length === value.length ? paths : null;
}

export function decodeShutdownSaveFlushResult(value: unknown): IShutdownSaveFlushResult | null {
    if (!isRecord(value)
        || typeof value.requestId !== 'string'
        || value.requestId.length < 1
        || value.requestId.length > 256
        || !Number.isSafeInteger(value.callbackCount)
        || (value.callbackCount as number) < 0
        || (value.callbackCount as number) > 1_024
        || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 16_384))) {
        return null;
    }
    const dirtyWorkingCopyPaths = decodeShutdownPathList(value.dirtyWorkingCopyPaths);
    const flushedWorkingCopyPaths = decodeShutdownPathList(value.flushedWorkingCopyPaths);
    if (dirtyWorkingCopyPaths === null || flushedWorkingCopyPaths === null) {
        return null;
    }
    return {
        callbackCount: value.callbackCount as number,
        requestId: value.requestId,
        ...(dirtyWorkingCopyPaths === undefined ? {} : {dirtyWorkingCopyPaths}),
        ...(flushedWorkingCopyPaths === undefined ? {} : {flushedWorkingCopyPaths}),
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
    };
}

export function decodeWindowCloseRequest(value: unknown): IWindowCloseRequest | null {
    if (!isRecord(value)
        || typeof value.requestId !== 'string'
        || value.requestId.length < 1
        || value.requestId.length > 256) {
        return null;
    }

    return {requestId: value.requestId};
}

export function decodeWindowCloseResponse(value: unknown): IWindowCloseResponse | null {
    if (!isRecord(value)
        || typeof value.requestId !== 'string'
        || value.requestId.length < 1
        || value.requestId.length > 256) {
        return null;
    }

    if (
        value.decision === 'save'
        || value.decision === 'discard'
        || value.decision === 'cancel'
    ) {
        return {
            decision: value.decision,
            requestId: value.requestId,
        };
    }

    if (
        value.status !== 'unavailable'
        || (
            value.reason !== 'no-handler'
            && value.reason !== 'multiple-handlers'
            && value.reason !== 'handler-error'
            && value.reason !== 'invalid-decision'
        )
    ) {
        return null;
    }

    return {
        requestId: value.requestId,
        status: 'unavailable',
        reason: value.reason,
    };
}
