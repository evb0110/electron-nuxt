export const DEFAULT_NUXT_PORT = 3235;

let nuxtPort = DEFAULT_NUXT_PORT;

export function getNuxtPort(): number {
    return nuxtPort;
}

export function setNuxtPort(port: number): void {
    if (!Number.isFinite(port) || port <= 0) {
        return;
    }
    nuxtPort = port;
}
