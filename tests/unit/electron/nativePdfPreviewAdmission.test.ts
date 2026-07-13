import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IJobBrokerLease,
    IJobBrokerRequest,
} from '@electron/resources/jobBroker';
import { acquireNativePdfPreviewAdmission } from '@electron/features/documents/main/acquireNativePdfPreviewAdmission';

const request = {
    ownerId: 'renderer-1',
    kind: 'native-pdf-preview',
    priority: 'visible',
    perOwnerLimit: 2,
    resources: {
        cpuTokens: 1,
        estimatedResidentBytes: 32,
        nativeProcesses: 1,
        ioWeight: 1,
    },
} as const;

describe('native PDF preview admission', () => {
    it('rejects a queued preview at the admission deadline', async () => {
        vi.useFakeTimers();
        try {
            const acquire = vi.fn((candidate: IJobBrokerRequest) => new Promise<IJobBrokerLease>((_resolve, reject) => {
                candidate.signal?.addEventListener('abort', () => reject(candidate.signal?.reason), {once: true});
            }));
            const promise = acquireNativePdfPreviewAdmission({
                acquire,
                ownerSignal: new AbortController().signal,
                request,
                timeoutMs: 25,
            });
            const rejection = expect(promise).rejects.toThrow(
                'Native PDF preview admission timed out after 25ms',
            );

            await vi.advanceTimersByTimeAsync(25);

            await rejection;
            expect(acquire.mock.calls[0]?.[0].signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('preserves owner cancellation while the preview is queued', async () => {
        const ownerController = new AbortController();
        const acquire = vi.fn((candidate: IJobBrokerRequest) => new Promise<IJobBrokerLease>((_resolve, reject) => {
            candidate.signal?.addEventListener('abort', () => reject(candidate.signal?.reason), {once: true});
        }));
        const promise = acquireNativePdfPreviewAdmission({
            acquire,
            ownerSignal: ownerController.signal,
            request,
            timeoutMs: 10_000,
        });

        ownerController.abort(new Error('preview generation superseded'));

        await expect(promise).rejects.toThrow('preview generation superseded');
    });

    it('clears the admission deadline once a lease is granted', async () => {
        vi.useFakeTimers();
        try {
            const lease = {
                token: 'lease-1',
                resources: request.resources,
                release: vi.fn(() => true),
            } satisfies IJobBrokerLease;
            let admittedSignal: AbortSignal | undefined;
            const result = await acquireNativePdfPreviewAdmission({
                acquire: (candidate) => {
                    admittedSignal = candidate.signal;
                    return Promise.resolve(lease);
                },
                ownerSignal: new AbortController().signal,
                request,
                timeoutMs: 25,
            });

            await vi.advanceTimersByTimeAsync(100);

            expect(result).toBe(lease);
            expect(admittedSignal?.aborted).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
