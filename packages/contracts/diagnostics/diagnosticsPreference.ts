export type TClientDiagnosticsPreference = 'unknown' | 'granted' | 'denied';

export function parseClientDiagnosticsPreference(value: unknown): TClientDiagnosticsPreference {
    return value === 'granted' || value === 'denied' ? value : 'unknown';
}
