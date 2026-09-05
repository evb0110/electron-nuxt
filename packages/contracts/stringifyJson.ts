// JSON.stringify returns undefined for undefined, functions, and symbols; the
// lib signature claims a plain string, so route it through a widened return.
export function stringifyJson(value: unknown): string | undefined {
    return JSON.stringify(value);
}
