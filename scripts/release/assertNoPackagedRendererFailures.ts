export function assertNoPackagedRendererFailures(failures: string[]) {
    if (failures.length > 0) {
        throw new Error(`Packaged renderer reported ${failures.length} error(s):\n${failures.join('\n')}`);
    }
}
