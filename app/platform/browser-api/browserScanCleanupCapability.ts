import type { IScanCleanupCapability } from '@contracts/electronApiScanCleanup';
import { noopUnsubscribe } from '@app/platform/browser-api/browserMenuHelpers';

const BROWSER_SCAN_CLEANUP_UNAVAILABLE = 'Scan Cleanup is unavailable in the browser; use the desktop app.';

export const browserScanCleanupCapability: IScanCleanupCapability = {
    preview() {
        return Promise.reject(new Error(BROWSER_SCAN_CLEANUP_UNAVAILABLE));
    },
    cancelPreview() {
        return Promise.resolve(false);
    },
    detectAll() {
        return Promise.resolve({
            started: false,
            jobId: 'browser:unavailable',
            error: BROWSER_SCAN_CLEANUP_UNAVAILABLE,
            errorCode: 'tools-unavailable',
        });
    },
    cancelDetection() {
        return Promise.resolve(false);
    },
    getDetectionJobState() {
        return Promise.resolve(null);
    },
    subscribeDetectionJob() {
        return Promise.resolve(null);
    },
    start() {
        return Promise.resolve({
            started: false,
            jobId: 'browser:unavailable',
            error: BROWSER_SCAN_CLEANUP_UNAVAILABLE,
            errorCode: 'tools-unavailable',
        });
    },
    cancel() {
        return Promise.resolve(false);
    },
    getJobState() {
        return Promise.resolve(null);
    },
    subscribeJob() {
        return Promise.resolve(null);
    },
    reconnectJob() {
        return Promise.resolve(null);
    },
    pruneGeneratedOutputs() {
        return Promise.resolve(0);
    },
    onPreviewRaw: noopUnsubscribe,
    onJobState: noopUnsubscribe,
    onDetectionJobState: noopUnsubscribe,
};
