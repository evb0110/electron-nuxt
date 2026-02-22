export function logPdfNav(message: string, ...args: unknown[]) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`, ...args);
}
