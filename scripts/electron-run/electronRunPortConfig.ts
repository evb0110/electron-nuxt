export const DEFAULT_NUXT_PORT = 3235;

let nuxtPort = DEFAULT_NUXT_PORT;

export function getNuxtPort() {
    return nuxtPort;
}

export function setNuxtPort(port: number) {
    if (!Number.isFinite(port) || port <= 0) {
        return;
    }
    nuxtPort = port;
}
