import type { Tagged } from 'type-fest';

export type TDocumentInstanceId = Tagged<string, 'DocumentInstanceId'>;

const DOCUMENT_INSTANCE_ID_MAX_LENGTH = 512;

export function parseDocumentInstanceId(value: unknown): TDocumentInstanceId | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= DOCUMENT_INSTANCE_ID_MAX_LENGTH
        ? normalized as TDocumentInstanceId
        : null;
}

export function requireDocumentInstanceId(value: unknown): TDocumentInstanceId {
    const parsed = parseDocumentInstanceId(value);
    if (parsed === null) {
        throw new TypeError('Document instance ID must be a non-empty string');
    }
    return parsed;
}
