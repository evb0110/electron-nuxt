import {isRecord} from '@contracts/runtimeGuards';

export const SERIALIZABLE_ERROR_PREFIX = 'EVB_SERIALIZABLE_ERROR:';

export interface ISerializableErrorEnvelope<TCode extends string = string> {
    code: TCode;
    message: string;
}

export function isSerializableErrorEnvelope(value: unknown): value is ISerializableErrorEnvelope {
    return isRecord(value)
        && typeof value.code === 'string'
        && value.code.length > 0
        && typeof value.message === 'string';
}

type TSerializableErrorEnvelopeGuard<TEnvelope extends ISerializableErrorEnvelope> = (
    value: unknown,
) => value is TEnvelope;

interface IDecodeSerializableErrorEnvelopeOptions {allowBareJsonString?: boolean;}

function decodeSerializableErrorPayload(
    value: unknown,
    options: IDecodeSerializableErrorEnvelopeOptions,
): unknown {
    if (typeof value !== 'string') {
        return value;
    }
    const markerIndex = value.indexOf(SERIALIZABLE_ERROR_PREFIX);
    if (markerIndex < 0 && options.allowBareJsonString !== true) {
        return null;
    }
    const encoded = markerIndex >= 0
        ? value.slice(markerIndex + SERIALIZABLE_ERROR_PREFIX.length).trim()
        : value.trim();
    if (!encoded.startsWith('{')) {
        return null;
    }
    try {
        return JSON.parse(encoded) as unknown;
    } catch {
        return null;
    }
}

export function encodeSerializableErrorEnvelope(envelope: ISerializableErrorEnvelope) {
    return `${SERIALIZABLE_ERROR_PREFIX}${JSON.stringify(envelope)}`;
}

export function decodeSerializableErrorEnvelope<TEnvelope extends ISerializableErrorEnvelope>(
    value: unknown,
    isEnvelope: TSerializableErrorEnvelopeGuard<TEnvelope>,
    options: IDecodeSerializableErrorEnvelopeOptions = {},
): TEnvelope | null {
    const decoded = decodeSerializableErrorPayload(value, options);
    return isEnvelope(decoded) ? decoded : null;
}

export function findSerializableErrorEnvelope<TEnvelope extends ISerializableErrorEnvelope>(
    value: unknown,
    isEnvelope: TSerializableErrorEnvelopeGuard<TEnvelope>,
): TEnvelope | null {
    const seen = new Set<object>();
    let candidate: unknown = value;
    while (candidate !== null && candidate !== undefined) {
        const decoded = decodeSerializableErrorEnvelope(candidate, isEnvelope);
        if (decoded) {
            return decoded;
        }
        if (!isRecord(candidate) || seen.has(candidate)) {
            return null;
        }
        seen.add(candidate);
        const ownEnvelope = decodeSerializableErrorEnvelope(candidate.errorEnvelope, isEnvelope);
        if (ownEnvelope) {
            return ownEnvelope;
        }
        const messageEnvelope = decodeSerializableErrorEnvelope(candidate.message, isEnvelope);
        if (messageEnvelope) {
            return messageEnvelope;
        }
        candidate = candidate.cause;
    }
    return null;
}

export class SerializableError<TEnvelope extends ISerializableErrorEnvelope> extends Error {
    readonly errorEnvelope: TEnvelope;
    readonly code: TEnvelope['code'];

    constructor(envelope: TEnvelope) {
        super(envelope.message);
        this.name = 'SerializableError';
        this.errorEnvelope = envelope;
        this.code = envelope.code;
    }
}
