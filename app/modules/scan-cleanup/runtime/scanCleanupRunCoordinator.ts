import type {
    IScanCleanupStartRequest,
    TScanCleanupStartResult,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {toBridgeSafeScanCleanupPayload} from '@app/modules/scan-cleanup/runtime/toBridgeSafeScanCleanupPayload';
import {toPlainScanCleanupOptions} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {dismissScanCleanupFirstRunGuidanceInStore} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const ACTIVE_JOB_KEY = 'evb.scanCleanup.activeJobId';
const ACTIVE_JOB_DOCUMENT_KEY = 'evb.scanCleanup.activeDocumentRef';
const ACTIVE_JOB_OWNER_KEY = 'evb.scanCleanup.activeOwnerId';
const ACTIVE_JOB_REVISION_KEY = 'evb.scanCleanup.activeDocumentRevision';
const terminalJobs = new Set<string>();

interface IScanCleanupRunError {
    error: string;
    ownerId: string;
}

export const scanCleanupRun = reactive({
    activeJobId: null as string | null,
    inFlight: false,
    workspaceOwnerIds: new Set<string>(),
    jobState: null as TScanCleanupJobState | null,
    lastError: null as IScanCleanupRunError | null,
    ownerDocumentRef: null as string | null,
    ownerDocumentRevision: null as string | null,
    ownerId: null as string | null,
});

export const isScanCleanupRunning = computed(() => Boolean(
    scanCleanupRun.inFlight
    || (
        scanCleanupRun.activeJobId
        && scanCleanupRun.jobState
        && [
            'queued',
            'running',
            'canceling',
            'handoff',
        ].includes(scanCleanupRun.jobState.status)
    ),
));

export function getScanCleanupRunError(ownerId: string) {
    return scanCleanupRun.lastError?.ownerId === ownerId
        ? scanCleanupRun.lastError.error
        : '';
}

export function setScanCleanupRunError(ownerId: string, error: string) {
    scanCleanupRun.lastError = error ? {
        error,
        ownerId,
    } : null;
}

export function reportScanCleanupRunError(
    ownerId: string,
    error: string,
    sourceDocumentRef: string | null = scanCleanupRun.ownerDocumentRef,
) {
    setScanCleanupRunError(ownerId, error);
    if (!dependencies || scanCleanupRun.workspaceOwnerIds.has(ownerId)) {
        return;
    }
    dependencies.toast.add({
        color: 'error',
        title: dependencies.t('scanCleanup.failed'),
        description: error,
        ...(sourceDocumentRef ? {actions: [{
            label: dependencies.t('scanCleanup.details'),
            color: 'neutral' as const,
            variant: 'outline' as const,
            onClick: () => { void dependencies?.openScanCleanupForDocument?.(sourceDocumentRef); },
        }]} : {}),
    });
}

export function resolveScanCleanupProcessedPages(
    state: TScanCleanupJobState | null,
    ownerDocumentRef: string | null,
    sourceDocumentRef: string | null,
    totalPages: number,
): ReadonlySet<number> {
    if (
        !state
        || !sourceDocumentRef
        || ownerDocumentRef !== sourceDocumentRef
        || ![
            'queued',
            'running',
            'handoff',
        ].includes(state.status)
    ) {
        return new Set();
    }
    return new Set((state.progress.completedPageNumbers ?? [])
        .filter(pageNumber => pageNumber <= totalPages));
}

interface IScanCleanupToast {add: (options: {
    color?: 'error' | 'info' | 'success';
    title: string;
    description?: string;
    actions?: Array<{
        label: string;
        color?: 'neutral' | 'primary';
        variant?: 'outline' | 'soft';
        onClick: () => void;
    }>;
}) => unknown;}

export interface IScanCleanupCoordinatorDependencies {
    openGeneratedPdf: (path: string) => Promise<boolean>;
    runOcrOnActiveDocument: () => Promise<boolean>;
    saveActiveDocumentAs: () => Promise<unknown>;
    openScanCleanupForDocument?: (documentRef: string) => Promise<boolean> | boolean;
    getOpenPdfPaths: () => string[];
    t: TTranslateFn;
    toast: IScanCleanupToast;
}

let installed = false;
let unsubscribe: (() => void) | null = null;
let dependencies: IScanCleanupCoordinatorDependencies | null = null;
let pendingStart: Pick<IScanCleanupStartRequest, 'documentRevision' | 'ownerId' | 'sourcePdfPath'> | null = null;
let startRequestPromise: Promise<TScanCleanupStartResult> | null = null;
let activeStartResult: Extract<TScanCleanupStartResult, {started: true}> | null = null;

function clearRunGuard() {
    scanCleanupRun.inFlight = false;
    pendingStart = null;
    startRequestPromise = null;
    activeStartResult = null;
}

function persistActiveJob(jobId: string | null, documentRef: string | null = scanCleanupRun.ownerDocumentRef) {
    if (!import.meta.client) {
        return;
    }
    if (jobId) {
        sessionStorage.setItem(ACTIVE_JOB_KEY, jobId);
        if (documentRef) {
            sessionStorage.setItem(ACTIVE_JOB_DOCUMENT_KEY, documentRef);
        }
        if (scanCleanupRun.ownerId) sessionStorage.setItem(ACTIVE_JOB_OWNER_KEY, scanCleanupRun.ownerId);
        if (scanCleanupRun.ownerDocumentRevision) sessionStorage.setItem(ACTIVE_JOB_REVISION_KEY, scanCleanupRun.ownerDocumentRevision);
    } else {
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_DOCUMENT_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_OWNER_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_REVISION_KEY);
    }
}

function summaryText(state: Extract<TScanCleanupJobState, {status: 'completed'}>) {
    return dependencies?.t('scanCleanup.summary', {
        input: state.summary.inputPages,
        output: state.summary.outputPages,
        spreads: state.summary.spreadsSplit,
        offcuts: state.summary.offcutsDiscarded,
    }) ?? '';
}

async function handleTerminalState(state: TScanCleanupJobState) {
    if (!dependencies || terminalJobs.has(state.jobId)) {
        return;
    }
    terminalJobs.add(state.jobId);
    scanCleanupRun.activeJobId = null;
    clearRunGuard();
    persistActiveJob(null);

    if (state.status === 'completed') {
        dismissScanCleanupFirstRunGuidanceInStore();
        const opened = await dependencies.openGeneratedPdf(state.outputPdfPath).catch(() => false);
        const ocrStarted = opened && state.runOcrAfterCleanup
            ? await dependencies.runOcrOnActiveDocument().catch(() => false)
            : false;
        dependencies.toast.add({
            color: opened ? 'success' : 'error',
            title: opened
                ? dependencies.t(ocrStarted ? 'scanCleanup.completedAndOcrTitle' : 'scanCleanup.completedTitle')
                : dependencies.t('scanCleanup.openResultFailed'),
            description: opened ? summaryText(state) : state.outputPdfPath,
            ...(opened ? {actions: [{
                label: dependencies.t('scanCleanup.saveAs'),
                color: 'neutral' as const,
                variant: 'outline' as const,
                onClick: () => { void dependencies?.saveActiveDocumentAs(); },
            }]} : {}),
        });
        return;
    }

    if (state.status === 'failed') {
        if (scanCleanupRun.ownerId) {
            reportScanCleanupRunError(
                scanCleanupRun.ownerId,
                state.error,
                scanCleanupRun.ownerDocumentRef,
            );
        } else {
            dependencies.toast.add({
                color: 'error',
                title: dependencies.t('scanCleanup.failed'),
                description: state.error,
                actions: [{
                    label: dependencies.t('scanCleanup.details'),
                    color: 'neutral',
                    variant: 'outline',
                    onClick: requestOwningScanCleanupWorkspace,
                }],
            });
        }
        return;
    }

    if (state.status === 'canceled' && (!scanCleanupRun.ownerId || !scanCleanupRun.workspaceOwnerIds.has(scanCleanupRun.ownerId))) {
        dependencies.toast.add({
            color: 'info',
            title: dependencies.t('scanCleanup.canceled'),
        });
    }
}

function acceptScanCleanupJobState(state: TScanCleanupJobState) {
    if (scanCleanupRun.activeJobId && state.jobId !== scanCleanupRun.activeJobId) {
        return;
    }
    if (!scanCleanupRun.activeJobId) {
        if (!pendingStart) {
            return;
        }
        scanCleanupRun.activeJobId = state.jobId;
        scanCleanupRun.ownerDocumentRef = pendingStart.sourcePdfPath;
        scanCleanupRun.ownerId = pendingStart.ownerId;
        scanCleanupRun.ownerDocumentRevision = pendingStart.documentRevision;
        persistActiveJob(state.jobId, pendingStart.sourcePdfPath);
    }
    scanCleanupRun.jobState = state;
    if ([
        'completed',
        'failed',
        'canceled',
    ].includes(state.status)) {
        void handleTerminalState(state);
    }
}

function requestOwningScanCleanupWorkspace() {
    if (scanCleanupRun.ownerDocumentRef) {
        void dependencies?.openScanCleanupForDocument?.(scanCleanupRun.ownerDocumentRef);
    }
}

async function startScanCleanupRequest(
    capability: NonNullable<ReturnType<typeof getScanCleanupCapability>>,
    request: IScanCleanupStartRequest,
): Promise<TScanCleanupStartResult> {
    let result: TScanCleanupStartResult;
    try {
        result = await capability.start(toBridgeSafeScanCleanupPayload({
            ...request,
            options: toPlainScanCleanupOptions(request.options),
        }));
    } catch (error) {
        clearRunGuard();
        throw error;
    }
    if (!result.started) {
        clearRunGuard();
        return result;
    }
    if (terminalJobs.has(result.jobId)) {
        clearRunGuard();
        return result;
    }
    terminalJobs.delete(result.jobId);
    activeStartResult = result;
    scanCleanupRun.activeJobId = result.jobId;
    scanCleanupRun.ownerDocumentRef = request.sourcePdfPath;
    scanCleanupRun.ownerId = request.ownerId;
    scanCleanupRun.ownerDocumentRevision = request.documentRevision;
    pendingStart = null;
    persistActiveJob(result.jobId, request.sourcePdfPath);
    const restored = await capability.subscribeJob(result.jobId, {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
    });
    if (restored) acceptScanCleanupJobState(restored);
    return result;
}

export function startScanCleanup(request: IScanCleanupStartRequest): Promise<TScanCleanupStartResult> {
    if (scanCleanupRun.inFlight) {
        if (startRequestPromise) {
            return startRequestPromise;
        }
        if (activeStartResult) {
            return Promise.resolve(activeStartResult);
        }
        return Promise.resolve({
            started: false,
            jobId: scanCleanupRun.activeJobId ?? '',
            error: 'Scan cleanup is already running',
            errorCode: 'internal',
        });
    }
    const capability = getScanCleanupCapability();
    if (!capability) {
        return Promise.resolve({
            started: false,
            jobId: '',
            error: 'Scan cleanup is unavailable',
            errorCode: 'tools-unavailable',
        });
    }
    scanCleanupRun.lastError = null;
    scanCleanupRun.inFlight = true;
    pendingStart = {
        ownerId: request.ownerId,
        documentRevision: request.documentRevision,
        sourcePdfPath: request.sourcePdfPath,
    };
    startRequestPromise = startScanCleanupRequest(capability, request);
    return startRequestPromise;
}

export async function cancelScanCleanup() {
    const capability = getScanCleanupCapability();
    return Boolean(capability && scanCleanupRun.activeJobId
        && scanCleanupRun.ownerId
        && scanCleanupRun.ownerDocumentRevision
        && await capability.cancel(scanCleanupRun.activeJobId, {
            ownerId: scanCleanupRun.ownerId,
            documentRevision: scanCleanupRun.ownerDocumentRevision,
        }));
}

export function setScanCleanupWorkspaceOwnerOpen(ownerId: string, open: boolean) {
    if (open) scanCleanupRun.workspaceOwnerIds.add(ownerId);
    else scanCleanupRun.workspaceOwnerIds.delete(ownerId);
}

export async function pruneScanCleanupOutputs() {
    const capability = getScanCleanupCapability();
    return capability && dependencies
        ? capability.pruneGeneratedOutputs(dependencies.getOpenPdfPaths())
        : 0;
}

export function installScanCleanupRunCoordinator(nextDependencies: IScanCleanupCoordinatorDependencies) {
    dependencies = nextDependencies;
    if (installed) {
        return () => undefined;
    }
    const capability = getScanCleanupCapability();
    if (!capability) {
        return () => undefined;
    }
    installed = true;
    unsubscribe = capability.onJobState(acceptScanCleanupJobState);
    const storedJobId = import.meta.client ? sessionStorage.getItem(ACTIVE_JOB_KEY) : null;
    if (storedJobId) {
        scanCleanupRun.activeJobId = storedJobId;
        scanCleanupRun.inFlight = true;
        scanCleanupRun.ownerDocumentRef = sessionStorage.getItem(ACTIVE_JOB_DOCUMENT_KEY);
        scanCleanupRun.ownerId = sessionStorage.getItem(ACTIVE_JOB_OWNER_KEY);
        scanCleanupRun.ownerDocumentRevision = sessionStorage.getItem(ACTIVE_JOB_REVISION_KEY);
        if (!scanCleanupRun.ownerId || !scanCleanupRun.ownerDocumentRevision) {
            scanCleanupRun.activeJobId = null;
            clearRunGuard();
            persistActiveJob(null);
        } else {
            void capability.reconnectJob(storedJobId, {
                ownerId: scanCleanupRun.ownerId,
                documentRevision: scanCleanupRun.ownerDocumentRevision,
            }).then(state => {
                if (state) acceptScanCleanupJobState(state);
                else {
                    scanCleanupRun.activeJobId = null;
                    clearRunGuard();
                    persistActiveJob(null);
                }
            });
        }
    }
    return () => {
        unsubscribe?.();
        unsubscribe = null;
        installed = false;
        dependencies = null;
    };
}
