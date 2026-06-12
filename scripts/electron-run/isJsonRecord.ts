export type TJsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is TJsonRecord {
    return typeof value === 'object' && value !== null;
}
