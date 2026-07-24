import type {
    IScanCleanupDetectionRequest,
    IScanCleanupOwnerContext,
    IScanCleanupPreviewCancelRequest,
    IScanCleanupPreviewRequest,
    IScanCleanupRawPreviewRequest,
    IScanCleanupStartRequest,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/ipc';
import {
    decodeDetectionArgs,
    decodeOpenPdfPaths,
    decodeOwnedJobId,
    decodePreviewArgs,
    decodePreviewCancelArgs,
    decodeRawPreviewArgs,
    decodeStartArgs,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {
    decodeDetectionStartResult,
    decodeScanCleanupDetectionJobState,
    decodeScanCleanupJobState,
    decodeScanCleanupPreviewResult,
    decodeScanCleanupRawPreviewResult,
    decodeStartResult,
} from '@contracts/scan-cleanup/ipcResultCodecs';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';

const owner: IScanCleanupOwnerContext = {
    ownerId: 'scan-cleanup-fixture',
    documentRevision: 'revision-1',
};
const options = {
    preserveOriginalQuality: false,
    layoutMode: 'auto' as const,
    outputMode: 'color' as const,
    readingOrder: 'ltr' as const,
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center' as const,
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    skipBlankPages: false,
    pageOverrides: {},
};
const rawRequest: IScanCleanupRawPreviewRequest = {
    ...owner,
    sourcePdfPath: '/tmp/source.pdf',
    pageNumber: 1,
};
const previewRequest: IScanCleanupPreviewRequest = {
    ...rawRequest,
    options,
};
const cancelPreviewRequest: IScanCleanupPreviewCancelRequest = {
    ...owner,
    sourcePdfPath: '/tmp/source.pdf',
};
const detectionRequest: IScanCleanupDetectionRequest = {
    ...cancelPreviewRequest,
    options,
};
const startRequest: IScanCleanupStartRequest = detectionRequest;
const queuedProgress = {
    stage: 'queued' as const,
    completedUnits: 0,
    totalUnits: 0,
    percent: 0,
    completedPageNumbers: [],
};
const queuedJobState: TScanCleanupJobState = {
    jobId: 'scan-cleanup-fixture',
    status: 'queued',
    progress: queuedProgress,
    updatedAtMs: 0,
};
const queuedDetectionState: TScanCleanupDetectionJobState = {
    jobId: 'scan-cleanup-detect-fixture',
    status: 'queued',
    progress: queuedProgress,
    results: [],
    updatedAtMs: 0,
};
const booleanResult = s.boolean();
const nonNegativeInteger = s.number({
    integer: true,
    min: 0,
    message: 'invalid scan-cleanup non-negative integer result',
});
const decodeArgs = <T>(decode: (value: readonly unknown[]) => T) =>
    (value: unknown) => decode(Array.isArray(value) ? value : []);
const rawPreviewArgs = s.fromParser(decodeArgs(decodeRawPreviewArgs), () => [rawRequest]);
const previewArgs = s.fromParser(decodeArgs(decodePreviewArgs), () => [previewRequest]);
const cancelPreviewArgs = s.fromParser(decodeArgs(decodePreviewCancelArgs), () => [cancelPreviewRequest]);
const detectionArgs = s.fromParser(decodeArgs(decodeDetectionArgs), () => [detectionRequest]);
const startArgs = s.fromParser(decodeArgs(decodeStartArgs), () => [startRequest]);
const ownedJobArgs = s.fromParser(decodeArgs(decodeOwnedJobId), () => [
    'scan-cleanup-fixture',
    owner,
] as [string, IScanCleanupOwnerContext]);
const openPathsArgs = s.fromParser(decodeArgs(decodeOpenPdfPaths), () => [['/tmp/source.pdf']]);
const rawPreviewResult = s.fromParser(decodeScanCleanupRawPreviewResult, () => ({
    pageNumber: 1,
    totalPages: 1,
    rawImageData: new Uint8Array([1]),
    rawWidthPx: 1,
    rawHeightPx: 1,
}));
const previewResult = s.fromParser(
    decodeScanCleanupPreviewResult,
    () => ({
        pageNumber: 1,
        totalPages: 1,
        rawImageData: new Uint8Array([1]),
        rawWidthPx: 1,
        rawHeightPx: 1,
        pageMetadata: {
            layoutClassification: 'single-uncut-page' as const,
            cutterXPx: null,
            rotationDegrees: 0 as const,
            canvasScope: 'document' as const,
            excluded: false,
            blankOutputsSkipped: 0,
            tier1Verdict: 'single-uncut-page' as const,
            reconciled: false,
            clusterAgreement: 0,
        },
        outputs: [],
    }),
);
const detectionStartResult = s.fromParser(decodeDetectionStartResult, () => ({
    started: true as const,
    jobId: 'scan-cleanup-detect-fixture',
}));
const startResult = s.fromParser(decodeStartResult, () => ({
    started: true as const,
    jobId: 'scan-cleanup-fixture',
    outputPdfPath: '/tmp/cleaned.pdf',
}));
const jobState = s.fromParser(decodeScanCleanupJobState, () => null);
const detectionJobState = s.fromParser(decodeScanCleanupDetectionJobState, () => null);
const jobEvent = s.fromNullableDecoder(
    decodeScanCleanupJobState,
    'scan-cleanup job state',
    () => queuedJobState,
);
const detectionEvent = s.fromNullableDecoder(
    decodeScanCleanupDetectionJobState,
    'scan-cleanup detection job state',
    () => queuedDetectionState,
);
const method = defineForwardedPlatformMethod;

export const SCAN_CLEANUP_PLATFORM_FEATURE = definePlatformFeature({
    path: ['scanCleanup'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        previewRaw: method({
            name: 'previewRaw',
            channel: 'scan-cleanup:preview:raw',
            args: rawPreviewArgs,
            result: rawPreviewResult,
            main: 'previewRaw',
        }),
        preview: method({
            name: 'preview',
            channel: 'scan-cleanup:preview',
            args: previewArgs,
            result: previewResult,
            main: 'preview',
        }),
        cancelPreview: method({
            name: 'cancelPreview',
            channel: 'scan-cleanup:preview:cancel',
            args: cancelPreviewArgs,
            result: booleanResult,
            main: 'cancelPreview',
        }),
        detectAll: method({
            name: 'detectAll',
            channel: 'scan-cleanup:detect-all',
            args: detectionArgs,
            result: detectionStartResult,
            main: 'detectAll',
        }),
        cancelDetection: method({
            name: 'cancelDetection',
            channel: 'scan-cleanup:detect-all:cancel',
            args: ownedJobArgs,
            result: booleanResult,
            main: 'cancelDetection',
        }),
        getDetectionJobState: method({
            name: 'getDetectionJobState',
            channel: 'scan-cleanup:detect-all:get-state',
            args: ownedJobArgs,
            result: detectionJobState,
            main: 'getDetectionJobState',
        }),
        subscribeDetectionJob: method({
            name: 'subscribeDetectionJob',
            channel: 'scan-cleanup:detect-all:subscribe',
            args: ownedJobArgs,
            result: detectionJobState,
            main: 'subscribeDetectionJob',
        }),
        start: method({
            name: 'start',
            channel: 'scan-cleanup:start',
            args: startArgs,
            result: startResult,
            main: 'start',
        }),
        cancel: method({
            name: 'cancel',
            channel: 'scan-cleanup:cancel',
            args: ownedJobArgs,
            result: booleanResult,
            main: 'cancel',
        }),
        getJobState: method({
            name: 'getJobState',
            channel: 'scan-cleanup:job:get-state',
            args: ownedJobArgs,
            result: jobState,
            main: 'getJobState',
        }),
        subscribeJob: method({
            name: 'subscribeJob',
            channel: 'scan-cleanup:job:subscribe',
            args: ownedJobArgs,
            result: jobState,
            main: 'subscribeJob',
        }),
        reconnectJob: method({
            name: 'reconnectJob',
            channel: 'scan-cleanup:job:reconnect',
            args: ownedJobArgs,
            result: jobState,
            main: 'reconnectJob',
        }),
        pruneGeneratedOutputs: {
            kind: 'async',
            channel: 'scan-cleanup:output:prune',
            ipc: {
                args: openPathsArgs,
                result: nonNegativeInteger,
            },
            main: {
                method: 'pruneGeneratedOutputs',
                context: 'none',
            },
            browser: {method: 'pruneGeneratedOutputs'},
            lazy: 'forwarded',
        },
    },
    events: {
        onJobState: {
            kind: 'event',
            channel: 'scan-cleanup:job:state',
            payload: jobEvent,
            browser: {method: 'onJobState'},
            lazy: 'forwarded',
        },
        onDetectionJobState: {
            kind: 'event',
            channel: 'scan-cleanup:detect-all:state',
            payload: detectionEvent,
            browser: {method: 'onDetectionJobState'},
            lazy: 'forwarded',
        },
    },
});

export type IScanCleanupCapability = TFeatureCapability<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
export type IScanCleanupInvokeMap = TFeatureInvokeMap<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
export type IScanCleanupEventMap = TFeatureEventMap<typeof SCAN_CLEANUP_PLATFORM_FEATURE>;
