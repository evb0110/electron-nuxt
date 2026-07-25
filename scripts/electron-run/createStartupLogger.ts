function formatElapsedMs(startedAt: number) {
    return `${((Date.now() - startedAt) / 1000).toFixed(2)}s`;
}

export function createStartupLogger(startedAt = Date.now()) {
    return (message: string) => {
        console.log(`[Startup +${formatElapsedMs(startedAt)}] ${message}`);
    };
}
