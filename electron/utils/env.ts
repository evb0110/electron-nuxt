export function parseIntegerEnv(
    name: string,
    fallback: number,
    minimum: number,
    maximum?: number,
) {
    const parsed = Number.parseInt(process.env[name] ?? `${fallback}`, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
        return fallback;
    }
    if (typeof maximum === 'number') {
        return Math.min(parsed, maximum);
    }
    return parsed;
}
