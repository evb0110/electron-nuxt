import { mainJobBroker } from '@electron/resources/jobBroker';

export async function withCompactDjvuResourceLease<T>(options: {
    jobId: string;
    kind: 'page' | 'combine';
    signal?: AbortSignal;
    task: () => Promise<T>;
}) {
    const isPage = options.kind === 'page';
    const lease = await mainJobBroker.acquire({
        ownerId: options.jobId,
        kind: `djvu-compact-${options.kind}`,
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: (isPage ? 192 : 256) * 1024 * 1024,
            nativeProcesses: 1,
            ioWeight: 2,
        },
        ...(isPage ? {perOwnerLimit: 2} : {}),
        ...(options.signal ? {signal: options.signal} : {}),
    });
    try {
        return await options.task();
    } finally {
        lease.release();
    }
}
