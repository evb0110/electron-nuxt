import type {
    IJobBrokerLease,
    IJobBrokerRequest,
} from '@electron/resources/jobBroker';

const NATIVE_PDF_PREVIEW_ADMISSION_TIMEOUT_MS = 15_000;

interface INativePdfPreviewAdmissionOptions {
    readonly acquire: (request: IJobBrokerRequest) => Promise<IJobBrokerLease>;
    readonly request: Omit<IJobBrokerRequest, 'signal'>;
    readonly ownerSignal: AbortSignal;
    readonly timeoutMs?: number;
}

export async function acquireNativePdfPreviewAdmission(
    options: INativePdfPreviewAdmissionOptions,
) {
    const timeoutMs = options.timeoutMs ?? NATIVE_PDF_PREVIEW_ADMISSION_TIMEOUT_MS;
    const admissionController = new AbortController();
    const timeout = setTimeout(() => {
        admissionController.abort(new Error(
            `Native PDF preview admission timed out after ${String(timeoutMs)}ms`,
        ));
    }, timeoutMs);
    timeout.unref?.();
    const signal = AbortSignal.any([
        options.ownerSignal,
        admissionController.signal,
    ]);

    try {
        return await options.acquire({
            ...options.request,
            signal,
        });
    } catch (error) {
        if (admissionController.signal.aborted && !options.ownerSignal.aborted) {
            throw admissionController.signal.reason;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
