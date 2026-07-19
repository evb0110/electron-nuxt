import type {
    IScanCleanupStartRequest,
    IScanCleanupStartResult,
    TScanCleanupJobState,
} from '@contracts/electronApiScanCleanup';
import type {TTranslateFn} from '@i18n-app';
import {getScanCleanupCapability} from '@app/utils/getScanCleanupCapability';

const ACTIVE_JOB_KEY = 'evb.scanCleanup.activeJobId';
const terminalJobs = new Set<string>();

export const scanCleanupRun = reactive({
    activeJobId: null as string | null,
    dialogOpen: false,
    jobState: null as TScanCleanupJobState | null,
    lastError: '',
    openRequestRevision: 0,
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
    saveActiveDocumentAs: () => Promise<unknown>;
    getOpenPdfPaths: () => string[];
    t: TTranslateFn;
    toast: IScanCleanupToast;
}

let installed = false;
let unsubscribe: (() => void) | null = null;
let dependencies: IScanCleanupCoordinatorDependencies | null = null;

function persistActiveJob(jobId: string | null) {
    if (!import.meta.client) {
        return;
    }
    if (jobId) sessionStorage.setItem(ACTIVE_JOB_KEY, jobId);
    else sessionStorage.removeItem(ACTIVE_JOB_KEY);
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
        const opened = await dependencies.openGeneratedPdf(state.outputPdfPath);
        dependencies.toast.add({
            color: opened ? 'success' : 'error',
            title: opened
                ? dependencies.t('scanCleanup.completedTitle')
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
        if (!scanCleanupRun.dialogOpen) {
            dependencies.toast.add({
                color: 'error',
                title: dependencies.t('scanCleanup.failed'),
                description: state.error,
                actions: [{
                    label: dependencies.t('scanCleanup.details'),
                    color: 'neutral',
                    variant: 'outline',
                    onClick: requestScanCleanupDialog,
                }],
            });
        }
        return;
    }

    if (state.status === 'canceled' && !scanCleanupRun.dialogOpen) {
        dependencies.toast.add({
            color: 'info',
            title: dependencies.t('scanCleanup.canceled'),
        });
    }
}

export function acceptScanCleanupJobState(state: TScanCleanupJobState) {
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

export function requestScanCleanupDialog() {
    scanCleanupRun.openRequestRevision += 1;
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
    const result = await capability.start(request);
    if (!result.started) {
        return result;
    }
    terminalJobs.delete(result.jobId);
    scanCleanupRun.activeJobId = result.jobId;
    persistActiveJob(result.jobId);
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
