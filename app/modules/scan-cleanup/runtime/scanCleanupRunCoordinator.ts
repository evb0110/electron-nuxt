import type {
    IScanCleanupStartRequest,
    IScanCleanupStartResult,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';
import {
    dismissScanCleanupFirstRunGuidance,
    toPlainScanCleanupOptions,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferences';

const ACTIVE_JOB_KEY = 'evb.scanCleanup.activeJobId';
const ACTIVE_JOB_DOCUMENT_KEY = 'evb.scanCleanup.activeDocumentRef';
const terminalJobs = new Set<string>();

export const scanCleanupRun = reactive({
    activeJobId: null as string | null,
    workspaceOpen: false,
    jobState: null as TScanCleanupJobState | null,
    lastError: '',
    ownerDocumentRef: null as string | null,
});

export const isScanCleanupRunning = computed(() => Boolean(
    scanCleanupRun.activeJobId
    && scanCleanupRun.jobState
    && [
        'queued',
        'running',
        'handoff',
    ].includes(scanCleanupRun.jobState.status),
));

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
    const processedCount = Math.min(
        Math.max(0, Math.trunc(totalPages)),
        Math.max(0, Math.trunc(state.progress.processedCount)),
    );
    return new Set(Array.from({length: processedCount}, (_, index) => index + 1));
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

function persistActiveJob(jobId: string | null, documentRef: string | null = scanCleanupRun.ownerDocumentRef) {
    if (!import.meta.client) {
        return;
    }
    if (jobId) {
        sessionStorage.setItem(ACTIVE_JOB_KEY, jobId);
        if (documentRef) {
            sessionStorage.setItem(ACTIVE_JOB_DOCUMENT_KEY, documentRef);
        }
    } else {
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        sessionStorage.removeItem(ACTIVE_JOB_DOCUMENT_KEY);
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
    persistActiveJob(null);

    if (state.status === 'completed') {
        dismissScanCleanupFirstRunGuidance();
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
        scanCleanupRun.lastError = state.error;
        if (!scanCleanupRun.workspaceOpen) {
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

    if (state.status === 'canceled' && !scanCleanupRun.workspaceOpen) {
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

export async function startScanCleanup(request: IScanCleanupStartRequest): Promise<IScanCleanupStartResult> {
    const capability = getScanCleanupCapability();
    if (!capability) {
        return {
            started: false,
            jobId: '',
            error: 'Scan cleanup is unavailable',
            errorCode: 'tools-unavailable',
        };
    }
    scanCleanupRun.lastError = '';
    const result = await capability.start({
        ...request,
        options: toPlainScanCleanupOptions(request.options),
    });
    if (!result.started) {
        return result;
    }
    terminalJobs.delete(result.jobId);
    scanCleanupRun.activeJobId = result.jobId;
    scanCleanupRun.ownerDocumentRef = request.sourcePdfPath;
    persistActiveJob(result.jobId, request.sourcePdfPath);
    const restored = await capability.subscribeJob(result.jobId);
    if (restored) acceptScanCleanupJobState(restored);
    return result;
}

export async function cancelScanCleanup() {
    const capability = getScanCleanupCapability();
    return Boolean(capability && scanCleanupRun.activeJobId
        && await capability.cancel(scanCleanupRun.activeJobId));
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
    installed = true;
    const capability = getScanCleanupCapability();
    if (!capability) {
        return () => undefined;
    }
    unsubscribe = capability.onJobState(acceptScanCleanupJobState);
    const storedJobId = import.meta.client ? sessionStorage.getItem(ACTIVE_JOB_KEY) : null;
    if (storedJobId) {
        scanCleanupRun.activeJobId = storedJobId;
        scanCleanupRun.ownerDocumentRef = sessionStorage.getItem(ACTIVE_JOB_DOCUMENT_KEY);
        void capability.reconnectJob(storedJobId).then(state => {
            if (state) acceptScanCleanupJobState(state);
            else {
                scanCleanupRun.activeJobId = null;
                persistActiveJob(null);
            }
        });
    }
    return () => {
        unsubscribe?.();
        unsubscribe = null;
        installed = false;
        dependencies = null;
    };
}
