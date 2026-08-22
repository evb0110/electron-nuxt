export type TElectronE2EInfrastructureFailureKind =
    | 'process-launch'
    | 'transport'
    | 'cdp-connection'
    | 'session-runner';

function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
}

function escapeInfrastructureMarkers(value: string) {
    return value.replace(/\[INFRA\]/gu, '[application-infra-marker]');
}

function formatContainedErrors(error: Error) {
    if (!(error instanceof AggregateError)) {
        return '';
    }
    return error.errors
        .map((containedError, index) => `\nContained error ${String(index + 1)}: ${toError(containedError).message}`)
        .join('');
}

export class ElectronE2EInfrastructureError extends Error {
    readonly kind: TElectronE2EInfrastructureFailureKind;

    constructor(
        kind: TElectronE2EInfrastructureFailureKind,
        message: string,
        cause?: unknown,
    ) {
        const source = cause === undefined ? null : toError(cause);
        const sourceDetails = source
            ? `${source.message}${formatContainedErrors(source)}`
            : '';
        super(
            `[INFRA] ${message}${source ? `\n${escapeInfrastructureMarkers(sourceDetails)}` : ''}`,
            source ? {cause: source} : undefined,
        );
        this.name = 'ElectronE2EInfrastructureError';
        this.kind = kind;
    }
}

export function createElectronE2EHealthReadinessFailure(
    sessionName: string,
    successfulResponseCount: number,
    lastTransportError: unknown,
    lastApplicationError?: unknown,
) {
    if (successfulResponseCount === 0) {
        return new ElectronE2EInfrastructureError(
            'transport',
            `Electron E2E session '${sessionName}' health transport was unavailable`,
            lastTransportError,
        );
    }
    const label = `Electron E2E session '${sessionName}' reported application health but did not become ready`;
    return lastApplicationError === undefined
        ? new Error(label)
        : formatElectronE2ESessionFailure(label, lastApplicationError);
}

export async function runElectronE2EInfrastructureStage<T>(
    kind: TElectronE2EInfrastructureFailureKind,
    label: string,
    operation: () => Promise<T>,
) {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof ElectronE2EInfrastructureError) {
            throw error;
        }
        throw new ElectronE2EInfrastructureError(kind, label, error);
    }
}

function isNodeSystemFailure(error: unknown): error is NodeJS.ErrnoException & {
    errno: number;
    syscall: string;
} {
    if (!(error instanceof Error)) {
        return false;
    }
    const candidate = error as NodeJS.ErrnoException;
    return typeof candidate.code === 'string'
        && typeof candidate.errno === 'number'
        && typeof candidate.syscall === 'string'
        && candidate.syscall.length > 0;
}

export async function runElectronE2EProcessLaunchStage<T>(
    label: string,
    operation: () => Promise<T>,
) {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof ElectronE2EInfrastructureError) {
            throw error;
        }
        if (isNodeSystemFailure(error)) {
            throw new ElectronE2EInfrastructureError('process-launch', label, error);
        }
        throw error;
    }
}

export function formatElectronE2ESessionFailure(label: string, error: unknown) {
    const source = toError(error);
    if (source instanceof ElectronE2EInfrastructureError) {
        return new ElectronE2EInfrastructureError(source.kind, label, source);
    }
    const sourceDetails = `${source.message}${formatContainedErrors(source)}`;
    const failure = new Error(`${label}\n${escapeInfrastructureMarkers(sourceDetails)}`);
    if (source.stack) {
        failure.stack = `${failure.name}: ${failure.message}\nCaused by: ${escapeInfrastructureMarkers(source.stack)}`;
    }
    return failure;
}
