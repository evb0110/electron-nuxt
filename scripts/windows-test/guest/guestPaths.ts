import { windowsTestGuestLayout } from '@scripts/windows-test/contracts/windowsTestPaths';

export const WINDOWS_GUEST_PATH_SEPARATOR = '\\';

export interface IGuestLayout {
    root: string;
    separator: string;
    inboxDir: string;
    outboxDir: string;
    stateDir: string;
    stagingDir: string;
    workDir: string;
    markerFile: string;
    bootIdFile: string;
    heartbeatFile: string;
}

export interface IGuestRunPaths {
    runId: string;
    runRoot: string;
    jobFile: string;
    readyMarkerFile: string;
    cancelFile: string;
    startedMarkerFile: string;
    resultFile: string;
    resultTempFile: string;
    evidenceDir: string;
    evidenceManifestFile: string;
    workerLogFile: string;
    inputsDir: string;
    outputsDir: string;
    profileDir: string;
    stagingDir: string;
    fixtureManifestFile: string;
}

export function joinGuestPath(separator: string, ...segments: string[]) {
    return segments.filter(segment => segment.length > 0).join(separator);
}

export function guestLayoutForRoot(root: string, separator: string = WINDOWS_GUEST_PATH_SEPARATOR): IGuestLayout {
    const at = (...segments: string[]) => joinGuestPath(separator, root, ...segments);
    return {
        root,
        separator,
        inboxDir: at('inbox'),
        outboxDir: at('outbox'),
        stateDir: at('state'),
        stagingDir: at('staging'),
        workDir: at('work'),
        markerFile: at('state', 'test-marker.json'),
        bootIdFile: at('state', 'boot-id.txt'),
        heartbeatFile: at('state', 'heartbeat.json'),
    };
}

export const defaultGuestLayout = guestLayoutForRoot(windowsTestGuestLayout.root);

export function guestRunPaths(layout: IGuestLayout, runId: string): IGuestRunPaths {
    const separator = layout.separator;
    const runRoot = joinGuestPath(separator, layout.workDir, runId);
    const stagingDir = joinGuestPath(separator, layout.stagingDir, runId);
    return {
        runId,
        runRoot,
        stagingDir,
        jobFile: joinGuestPath(separator, layout.inboxDir, `${runId}.job.json`),
        readyMarkerFile: joinGuestPath(separator, layout.inboxDir, `${runId}.ready`),
        cancelFile: joinGuestPath(separator, layout.inboxDir, `${runId}.cancel`),
        startedMarkerFile: joinGuestPath(separator, layout.stateDir, `${runId}.started`),
        resultFile: joinGuestPath(separator, layout.outboxDir, `${runId}.result.json`),
        resultTempFile: joinGuestPath(separator, layout.outboxDir, `${runId}.result.json.tmp`),
        evidenceDir: joinGuestPath(separator, runRoot, 'evidence'),
        evidenceManifestFile: joinGuestPath(separator, runRoot, 'evidence-manifest.json'),
        workerLogFile: joinGuestPath(separator, runRoot, 'worker.log'),
        inputsDir: joinGuestPath(separator, runRoot, 'inputs'),
        outputsDir: joinGuestPath(separator, runRoot, 'outputs'),
        profileDir: joinGuestPath(separator, runRoot, 'profile'),
        fixtureManifestFile: joinGuestPath(separator, stagingDir, 'fixtures', 'manifest.json'),
    };
}

export const READY_MARKER_SUFFIX = '.ready';

export function readyMarkerRunId(fileName: string) {
    return fileName.endsWith(READY_MARKER_SUFFIX)
        ? fileName.slice(0, -READY_MARKER_SUFFIX.length)
        : null;
}

function normalizeGuestPath(value: string, separator: string) {
    const unified = separator === '\\'
        ? value.replaceAll('/', '\\').toLowerCase()
        : value;
    return unified.replace(new RegExp(`${separator === '\\' ? '\\\\' : separator}+$`, 'u'), '');
}

export function isPathInsideGuestRoot(layout: IGuestLayout, candidate: string) {
    if (candidate.length === 0 || candidate.includes('..')) {
        return false;
    }
    const root = normalizeGuestPath(layout.root, layout.separator);
    const target = normalizeGuestPath(candidate, layout.separator);
    return target === root || target.startsWith(`${root}${layout.separator}`);
}
