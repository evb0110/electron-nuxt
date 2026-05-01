import { spawn } from 'node:child_process';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type {
    ProgressInfo,
    UpdateDownloadedEvent,
    UpdateInfo,
} from 'electron-updater';
import type {
    IAppUpdateStatus,
    TAppUpdateCheckOrigin,
} from '@contracts/electron-api';
import type { ILatestReleaseResponse } from '@contracts';
import { config } from '@electron/config';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import { isAbortError } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const { autoUpdater } = electronUpdater;

const logger = createLogger('updates');
const UPDATER_SUPPORTED_PLATFORMS = new Set([
    'darwin',
    'win32',
]);
const METADATA_REQUEST_TIMEOUT_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_JITTER_RATIO = 0.12;
const CODESIGN_CHECK_TIMEOUT_MS = 5_000;
const UPDATE_PROGRESS_BROADCAST_THROTTLE_MS = 250;

const defaultStatus: IAppUpdateStatus = {
    phase: 'idle',
    origin: 'auto',
    version: null,
    percent: null,
    message: null,
};

let status: IAppUpdateStatus = { ...defaultStatus };
let emitStatus: (status: IAppUpdateStatus) => void = () => {};
let initialized = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let currentCheckPromise: Promise<void> | null = null;
let currentCheckOrigin: TAppUpdateCheckOrigin = 'auto';
let downloadedVersion: string | null = null;
let pendingVersion: string | null = null;
let codeSignatureCheckPromise: Promise<boolean> | null = null;
let codeSignatureValid: boolean | null = null;
let listenersRegistered = false;
let progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressBroadcastAt = 0;
const autoUpdaterListenerUnsubscribe: Array<() => void> = [];

function getCurrentVersion() {
    return normalizeVersion(app.getVersion()) || null;
}

function normalizeVersion(version: string | null | undefined) {
    if (!version) {
        return '';
    }

    return version.trim().replace(/^v/i, '').split('-')[0] ?? '';
}

function versionParts(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return [] as number[];
    }

    return normalized.split('.').map((segment) => {
        const parsed = Number.parseInt(segment, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    });
}

function compareVersions(left: string, right: string) {
    const leftParts = versionParts(left);
    const rightParts = versionParts(right);
    const maxLength = Math.max(leftParts.length, rightParts.length);

    for (let i = 0; i < maxLength; i += 1) {
        const leftValue = leftParts[i] ?? 0;
        const rightValue = rightParts[i] ?? 0;
        if (leftValue === rightValue) {
            continue;
        }
        return leftValue > rightValue ? 1 : -1;
    }

    return 0;
}

function clearProgressBroadcastTimer() {
    if (!progressBroadcastTimer) {
        return;
    }

    clearTimeout(progressBroadcastTimer);
    progressBroadcastTimer = null;
}

function broadcastStatusNow() {
    emitStatus(status);
}

function broadcastProgressStatus() {
    clearProgressBroadcastTimer();
    lastProgressBroadcastAt = Date.now();
    broadcastStatusNow();
}

function updateStatus(next: Partial<IAppUpdateStatus>) {
    status = {
        ...status,
        ...next,
    };

    if (status.phase !== 'downloading') {
        clearProgressBroadcastTimer();
        broadcastStatusNow();
        return;
    }

    const now = Date.now();
    const elapsed = now - lastProgressBroadcastAt;
    const shouldBroadcastImmediately = lastProgressBroadcastAt === 0
        || status.percent === 0
        || status.percent === 100
        || elapsed >= UPDATE_PROGRESS_BROADCAST_THROTTLE_MS;

    if (shouldBroadcastImmediately) {
        broadcastProgressStatus();
        return;
    }

    if (!progressBroadcastTimer) {
        const delay = Math.max(0, UPDATE_PROGRESS_BROADCAST_THROTTLE_MS - elapsed);
        progressBroadcastTimer = setTimeout(() => {
            progressBroadcastTimer = null;
            if (status.phase !== 'downloading') {
                return;
            }
            broadcastProgressStatus();
        }, delay);
        progressBroadcastTimer.unref?.();
    }
}

function setIdleStatus(origin: TAppUpdateCheckOrigin, version: string | null = getCurrentVersion()) {
    updateStatus({
        phase: 'idle',
        origin,
        version,
        percent: null,
        message: null,
    });
}

function isUpdaterRuntimeSupported() {
    return app.isPackaged && UPDATER_SUPPORTED_PLATFORMS.has(process.platform);
}

async function checkMacCodeSignature() {
    return new Promise<boolean>((resolve) => {
        const appBundle = path.resolve(process.execPath, '..', '..', '..');
        const child = spawn('codesign', [
            '-d',
            '--verbose=2',
            appBundle,
        ], {
            shell: false,
            windowsHide: true,
            stdio: [
                'ignore',
                'ignore',
                'pipe',
            ],
        });

        let stderr = '';
        let finished = false;
        let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
            timeoutHandle = null;
            if (finished) {
                return;
            }
            finished = true;
            try {
                child.kill('SIGKILL');
            } catch {
                // Ignore kill failures after timeout.
            }
            resolve(false);
        }, CODESIGN_CHECK_TIMEOUT_MS);
        timeoutHandle.unref?.();

        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.once('error', () => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            resolve(false);
        });

        child.once('close', (code) => {
            if (finished) {
                return;
            }
            finished = true;
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
            if (code !== 0) {
                resolve(false);
                return;
            }
            resolve(!stderr.includes('Signature=adhoc'));
        });
    });
}

async function ensureUpdaterSupported() {
    if (!isUpdaterRuntimeSupported()) {
        return false;
    }
    if (process.platform !== 'darwin') {
        return true;
    }
    if (codeSignatureValid !== null) {
        return codeSignatureValid;
    }

    if (!codeSignatureCheckPromise) {
        codeSignatureCheckPromise = checkMacCodeSignature()
            .then((valid) => {
                codeSignatureValid = valid;
                if (!valid) {
                    logger.info('Ad-hoc code signature detected; auto-updates require Developer ID signing');
                }
                return valid;
            })
            .catch(() => {
                codeSignatureValid = false;
                logger.info('Unable to validate macOS code signature; updater disabled');
                return false;
            })
            .finally(() => {
                codeSignatureCheckPromise = null;
            });
    }

    return codeSignatureCheckPromise;
}

async function readSkippedVersion() {
    const settings = await loadSettings();
    const skipped = normalizeVersion(settings.skippedUpdateVersion);
    return skipped || null;
}

async function writeSkippedVersion(version: string | null) {
    const normalized = normalizeVersion(version);
    await updateSettings((settings) => {
        settings.skippedUpdateVersion = normalized || undefined;
    });
}

async function fetchLatestMetadataVersion() {
    const response = await fetch(config.updates.metadataUrl, {
        headers: {accept: 'application/json'},
        signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`Metadata endpoint responded with ${response.status}`);
    }

    const payload = await response.json() as Partial<ILatestReleaseResponse>;
    const latestTag = normalizeVersion(payload.release?.tag);
    if (!latestTag) {
        throw new Error('Metadata endpoint did not return release.tag');
    }
    return latestTag;
}

async function maybeClearSupersededDownloadedVersion() {
    if (!downloadedVersion) {
        return false;
    }

    try {
        const latestVersion = await fetchLatestMetadataVersion();
        if (compareVersions(latestVersion, downloadedVersion) <= 0) {
            return false;
        }

        logger.info(
            `Discarding cached downloaded update ${downloadedVersion} in favor of newer metadata release ${latestVersion}`,
        );
        downloadedVersion = null;
        pendingVersion = latestVersion;
        return true;
    } catch (error) {
        logger.warn(
            `Unable to verify whether downloaded update ${downloadedVersion} is current: ${
                getErrorMessage(error)
            }`,
        );
        return false;
    }
}

function scheduleNextPoll() {
    if (!isUpdaterRuntimeSupported()) {
        return;
    }

    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    const baseInterval = Math.max(config.updates.pollIntervalMs, MIN_POLL_INTERVAL_MS);
    const jitter = Math.round(baseInterval * ((Math.random() * 2 * MAX_JITTER_RATIO) - MAX_JITTER_RATIO));
    const delay = Math.max(MIN_POLL_INTERVAL_MS, baseInterval + jitter);

    pollTimer = setTimeout(() => {
        void checkForUpdates('auto')
            .catch((error) => {
                logger.error(`Automatic update poll failed: ${getErrorMessage(error)}`);
            })
            .finally(() => {
                scheduleNextPoll();
            });
    }, delay);
}

function setAutoUpdaterListeners() {
    if (listenersRegistered) {
        return;
    }
    listenersRegistered = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;

    const onCheckingForUpdate = () => {
        updateStatus({
            phase: 'checking',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: null,
            message: null,
        });
    };
    autoUpdater.on('checking-for-update', onCheckingForUpdate);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('checking-for-update', onCheckingForUpdate);
    });

    const onUpdateAvailable = (info: UpdateInfo) => {
        const version = normalizeVersion(info.version) || pendingVersion;
        pendingVersion = version || null;
        updateStatus({
            phase: 'downloading',
            origin: currentCheckOrigin,
            version: version || null,
            percent: 0,
            message: null,
        });
    };
    autoUpdater.on('update-available', onUpdateAvailable);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-available', onUpdateAvailable);
    });

    const onDownloadProgress = (progress: ProgressInfo) => {
        updateStatus({
            phase: 'downloading',
            origin: currentCheckOrigin,
            version: pendingVersion,
            percent: progress.percent,
            message: null,
        });
    };
    autoUpdater.on('download-progress', onDownloadProgress);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('download-progress', onDownloadProgress);
    });

    const onUpdateNotAvailable = (info: UpdateInfo) => {
        pendingVersion = null;
        if (currentCheckOrigin !== 'manual') {
            setIdleStatus('auto', normalizeVersion(info.version) || getCurrentVersion());
            return;
        }

        updateStatus({
            phase: 'no-update',
            origin: 'manual',
            version: normalizeVersion(info.version) || normalizeVersion(app.getVersion()) || null,
            percent: null,
            message: null,
        });
    };
    autoUpdater.on('update-not-available', onUpdateNotAvailable);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-not-available', onUpdateNotAvailable);
    });

    const onUpdaterError = (error: unknown) => {
        logger.error(`Updater error: ${getErrorMessage(error)}`);
        if (currentCheckOrigin !== 'manual') {
            pendingVersion = null;
            setIdleStatus('auto');
            return;
        }

        updateStatus({
            phase: 'error',
            origin: 'manual',
            version: pendingVersion,
            percent: null,
            message: getErrorMessage(error),
        });
    };
    autoUpdater.on('error', onUpdaterError);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('error', onUpdaterError);
    });

    const onUpdateDownloaded = async (event: UpdateDownloadedEvent) => {
        try {
            const version = normalizeVersion(event.version) || pendingVersion;
            pendingVersion = version || null;
            downloadedVersion = version || null;

            const skippedVersion = await readSkippedVersion();
            if (
                currentCheckOrigin === 'auto'
                && skippedVersion
                && version
                && skippedVersion === version
            ) {
                logger.info(`Update ${version} downloaded but skipped for automatic prompts`);
                updateStatus({
                    phase: 'idle',
                    origin: 'auto',
                    version,
                    percent: null,
                    message: null,
                });
                return;
            }

            updateStatus({
                phase: 'downloaded',
                origin: currentCheckOrigin,
                version: version || null,
                percent: 100,
                message: null,
            });
        } catch (error) {
            logger.error(`Failed to process downloaded update event: ${getErrorMessage(error)}`);
            updateStatus({
                phase: 'error',
                origin: currentCheckOrigin,
                version: pendingVersion,
                percent: null,
                message: getErrorMessage(error),
            });
        }
    };
    autoUpdater.on('update-downloaded', onUpdateDownloaded);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-downloaded', onUpdateDownloaded);
    });
}

async function shouldRunUpdaterCheck(origin: TAppUpdateCheckOrigin) {
    if (origin === 'manual') {
        // Manual checks should always hit the updater feed directly.
        // Metadata can be stale because it is CDN-cached.
        return true;
    }

    const currentVersion = normalizeVersion(app.getVersion());
    let latestVersion: string;

    try {
        latestVersion = await fetchLatestMetadataVersion();
    } catch (error) {
        const message = isAbortError(error)
            ? 'Timed out while checking for updates.'
            : getErrorMessage(error);
        logger.warn(`Unable to query update metadata: ${message}`);
        return true;
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
        pendingVersion = null;
        return false;
    }

    const skippedVersion = await readSkippedVersion();
    if (
        skippedVersion
        && compareVersions(latestVersion, skippedVersion) > 0
    ) {
        // Newer release exists; stale skip can be dropped.
        await writeSkippedVersion(null);
    }

    if (skippedVersion && skippedVersion === latestVersion) {
        logger.info(`Skipping automatic prompt for ignored version ${latestVersion}`);
        pendingVersion = null;
        return false;
    }

    pendingVersion = latestVersion;
    return true;
}

async function checkForUpdates(origin: TAppUpdateCheckOrigin) {
    try {
        if (!isUpdaterRuntimeSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: normalizeVersion(app.getVersion()) || null,
                    percent: null,
                    message: 'Updates are available only in packaged macOS/Windows builds.',
                });
            }
            return;
        }
        if (!await ensureUpdaterSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: normalizeVersion(app.getVersion()) || null,
                    percent: null,
                    message: 'Updates require a signed packaged build.',
                });
            } else {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'auto',
                    version: normalizeVersion(app.getVersion()) || null,
                    percent: null,
                    message: null,
                });
            }
            return;
        }

        if (currentCheckPromise) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'checking',
                    origin: 'manual',
                    version: pendingVersion,
                    percent: null,
                    message: null,
                });
                if (currentCheckOrigin === 'auto') {
                    await currentCheckPromise;
                    return checkForUpdates('manual');
                }
            }
            return;
        }

        const supersededDownloadedVersion = await maybeClearSupersededDownloadedVersion();
        if (downloadedVersion && !supersededDownloadedVersion) {
            const skippedVersion = await readSkippedVersion();
            if (!(origin === 'auto' && skippedVersion === downloadedVersion)) {
                updateStatus({
                    phase: 'downloaded',
                    origin,
                    version: downloadedVersion,
                    percent: 100,
                    message: null,
                });
            }
            return;
        }

        currentCheckOrigin = origin;
        currentCheckPromise = (async () => {
            const shouldCheckBinary = await shouldRunUpdaterCheck(origin);
            if (!shouldCheckBinary) {
                if (origin === 'manual') {
                    updateStatus({
                        phase: 'no-update',
                        origin: 'manual',
                        version: getCurrentVersion(),
                        percent: null,
                        message: null,
                    });
                } else {
                    setIdleStatus('auto');
                }
                return;
            }

            try {
                await autoUpdater.checkForUpdates();
            } catch (error) {
                logger.error(`checkForUpdates failed: ${getErrorMessage(error)}`);
                if (origin === 'manual') {
                    updateStatus({
                        phase: 'error',
                        origin: 'manual',
                        version: pendingVersion,
                        percent: null,
                        message: getErrorMessage(error),
                    });
                }
            }
        })().finally(() => {
            currentCheckPromise = null;
        });

        await currentCheckPromise;
    } catch (error) {
        logger.error(`checkForUpdates internal failure: ${getErrorMessage(error)}`);
        if (origin === 'manual') {
            updateStatus({
                phase: 'error',
                origin: 'manual',
                version: pendingVersion,
                percent: null,
                message: getErrorMessage(error),
            });
        }
    }
}

export function initializeUpdates(onStatus: (status: IAppUpdateStatus) => void) {
    emitStatus = onStatus;
    emitStatus(status);

    if (initialized) {
        return;
    }
    initialized = true;

    setAutoUpdaterListeners();

    if (!isUpdaterRuntimeSupported()) {
        logger.info('Automatic updates disabled in this runtime');
        updateStatus({
            phase: 'unsupported',
            origin: 'auto',
            version: getCurrentVersion(),
            percent: null,
            message: null,
        });
        return;
    }

    if (process.platform === 'darwin') {
        void ensureUpdaterSupported()
            .then((supported) => {
                if (supported) {
                    return;
                }
                if (pollTimer) {
                    clearTimeout(pollTimer);
                    pollTimer = null;
                }
                updateStatus({
                    phase: 'unsupported',
                    origin: 'auto',
                    version: getCurrentVersion(),
                    percent: null,
                    message: null,
                });
            })
            .catch((error) => {
                logger.warn(`Updater signature check failed: ${getErrorMessage(error)}`);
            });
    }

    const initialDelayMs = Math.max(config.updates.initialDelayMs, 1000);
    pollTimer = setTimeout(() => {
        void checkForUpdates('auto')
            .catch((error) => {
                logger.error(`Initial automatic update check failed: ${getErrorMessage(error)}`);
            })
            .finally(() => {
                scheduleNextPoll();
            });
    }, initialDelayMs);
}

export async function triggerManualUpdateCheck() {
    await checkForUpdates('manual');
    return { started: true };
}

export function getUpdateStatus() {
    return status;
}

export async function installDownloadedUpdate() {
    if (!downloadedVersion) {
        return { started: false };
    }

    // Installation is always user-initiated, so errors must surface to the UI
    currentCheckOrigin = 'manual';

    try {
        await writeSkippedVersion(null);
    } catch (error) {
        logger.warn(`Failed to clear skipped update version before install: ${getErrorMessage(error)}`);
    }
    autoUpdater.quitAndInstall(false, true);
    return { started: true };
}

export async function deferDownloadedUpdate() {
    if (!downloadedVersion) {
        return;
    }

    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: downloadedVersion,
        percent: null,
        message: null,
    });
}

export async function skipUpdateVersion(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return;
    }

    await writeSkippedVersion(normalized);
    downloadedVersion = null;
    pendingVersion = null;
    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: normalized,
        percent: null,
        message: null,
    });
}

export async function shutdownUpdates() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    clearProgressBroadcastTimer();
    lastProgressBroadcastAt = 0;

    if (currentCheckPromise) {
        try {
            await currentCheckPromise;
        } catch {
            // Ignore in-flight check failures during shutdown.
        }
    }

    for (const unsubscribe of autoUpdaterListenerUnsubscribe.splice(0)) {
        try {
            unsubscribe();
        } catch {
            // Ignore listener cleanup failures.
        }
    }
    listenersRegistered = false;
}
