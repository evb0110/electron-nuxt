import { app } from 'electron';
import electronUpdater, {CancellationToken} from 'electron-updater';
import { clamp } from 'es-toolkit/math';
import type {
    ProgressInfo,
    UpdateDownloadedEvent,
    UpdateInfo,
} from 'electron-updater';
import type {
    IAppUpdateStatus,
    TAppUpdateCheckOrigin,
} from '@contracts/updatesPlatformFeature';
import { config } from '@electron/config';
import {
    loadSettings,
    updateSettings,
} from '@electron/settings';
import { isAbortError } from '@electron/utils/abort';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import {
    compareVersions,
    normalizeVersion,
} from '@electron/updates/versionCompare';
import { checkMacCodeSignature } from '@electron/updates/checkMacCodeSignature';
import { decodeLatestReleaseTag } from '@electron/updates/decodeLatestReleaseTag';
import {
    getSuppressedUpdateVersion,
    markUpdateInstallPending,
    recordPendingUpdateStartup,
    UPDATE_STARTUP_FAILURE_THRESHOLD,
} from '@electron/updateHealthMarker';
import { runDetached } from '@electron/utils/runDetached';
import { resolveApplicationVersion } from '@electron/appVersion';

const { autoUpdater } = electronUpdater;

const logger = createLogger('updates');
const UPDATER_SUPPORTED_PLATFORMS = new Set([
    'darwin',
    'win32',
]);
const UPDATER_SUPPORTED_ARCH_BY_PLATFORM: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
    // Release metadata is published only for the signed mac arm64 and signed
    // Windows x64 updater lanes. Other artifacts remain manual-install only.
    darwin: new Set(['arm64']),
    win32: new Set(['x64']),
};
const METADATA_REQUEST_TIMEOUT_MS = 10_000;
const MIN_POLL_INTERVAL_MS = 60_000;
const MAX_JITTER_RATIO = 0.12;
const UPDATE_PROGRESS_BROADCAST_THROTTLE_MS = 250;
const UPDATER_SHUTDOWN_CHECK_WAIT_TIMEOUT_MS = 3_000;
const UPDATER_SHUTDOWN_DOWNLOAD_WAIT_TIMEOUT_MS = 3_000;
const GITHUB_RELEASE_OWNER = 'evb0110';
const GITHUB_RELEASE_REPOSITORY = 'evb-viewer';
const GITHUB_RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${GITHUB_RELEASE_OWNER}/${GITHUB_RELEASE_REPOSITORY}/releases/download`;
let resolvedReleaseFeedBaseUrl = GITHUB_RELEASE_DOWNLOAD_BASE_URL;

interface IUpdaterCheckDecision {
    shouldCheck: boolean;
    targetVersion: string | null;
}

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
let currentDownloadPromise: Promise<void> | null = null;
let currentDownloadCancellationToken: CancellationToken | null = null;
let currentCheckOrigin: TAppUpdateCheckOrigin = 'auto';
let isShuttingDown = false;
let downloadedVersion: string | null = null;
let pendingVersion: string | null = null;
let approvedDownloadAndInstallVersion: string | null = null;
let codeSignatureCheckPromise: Promise<boolean> | null = null;
let codeSignatureValid: boolean | null = null;
let listenersRegistered = false;
let progressBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressBroadcastAt = 0;
const autoUpdaterListenerUnsubscribe: Array<() => void> = [];
type TUpdateInstallShutdownRequester = (install: () => void) => void;
let requestUpdateInstallShutdown: TUpdateInstallShutdownRequester = (install) => {
    install();
};

export function configureUpdateInstallShutdown(requester: TUpdateInstallShutdownRequester | null) {
    requestUpdateInstallShutdown = requester ?? ((install) => {
        install();
    });
}

function getCurrentVersion() {
    return normalizeVersion(resolveApplicationVersion(app)) || null;
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
    const supportedArchs = UPDATER_SUPPORTED_ARCH_BY_PLATFORM[process.platform];
    return app.isPackaged
        && process.windowsStore !== true
        && UPDATER_SUPPORTED_PLATFORMS.has(process.platform)
        && Boolean(supportedArchs?.has(process.arch));
}

function getUnsupportedRuntimeMessage() {
    if (process.windowsStore === true) {
        return 'Updates for the Microsoft Store build are delivered by Microsoft Store.';
    }
    return `Updates are available only in packaged macOS arm64 and Windows x64 builds. Current runtime: ${process.platform}-${process.arch}.`;
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

    codeSignatureCheckPromise ??= checkMacCodeSignature()
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
        if (normalized) {
            settings.skippedUpdateVersion = normalized;
        } else {
            delete settings.skippedUpdateVersion;
        }
        return undefined;
    });
}

async function fetchLatestMetadataVersion() {
    const errors: string[] = [];
    for (const metadataUrl of [
        config.updates.metadataUrl,
        config.updates.mirrorMetadataUrl,
    ]) {
        try {
            const response = await fetch(metadataUrl, {
                headers: {accept: 'application/json'},
                signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
            });

            if (!response.ok) {
                throw new Error(`Metadata endpoint responded with ${response.status}`);
            }

            const payload: unknown = await response.json();
            const latestTag = normalizeVersion(decodeLatestReleaseTag(payload));
            if (!latestTag) {
                throw new Error('Metadata endpoint did not return release.tag');
            }
            return latestTag;
        } catch (error) {
            errors.push(`${metadataUrl}: ${getErrorMessage(error)}`);
        }
    }

    throw new Error(`All update metadata sources failed (${errors.join('; ')})`);
}

function getUpdaterMetadataAssetName() {
    if (process.platform === 'win32') {
        return 'latest.yml';
    }
    if (process.platform === 'darwin') {
        return 'latest-mac.yml';
    }
    return null;
}

function getReleaseTag(version: string) {
    return version.startsWith('v') ? version : `v${version}`;
}

function getUpdaterReleaseFeedUrl(version: string, baseUrl = resolvedReleaseFeedBaseUrl) {
    return `${baseUrl}/${encodeURIComponent(getReleaseTag(version))}`;
}

function configureUpdaterFeed(targetVersion: string | null) {
    if (targetVersion) {
        autoUpdater.setFeedURL({
            provider: 'generic',
            url: getUpdaterReleaseFeedUrl(targetVersion),
            // GitHub release downloads redirect through S3, whose responses do
            // not support electron-updater's multi-range request format.
            useMultipleRangeRequest: false,
        });
        return;
    }

    autoUpdater.setFeedURL({
        provider: 'github',
        owner: GITHUB_RELEASE_OWNER,
        repo: GITHUB_RELEASE_REPOSITORY,
    });
}

async function hasUpdaterMetadataForVersion(version: string) {
    const assetName = getUpdaterMetadataAssetName();
    if (!assetName) {
        return false;
    }

    const errors: string[] = [];
    for (const baseUrl of [
        GITHUB_RELEASE_DOWNLOAD_BASE_URL,
        config.updates.mirrorReleaseBaseUrl,
    ]) {
        try {
            const url = `${getUpdaterReleaseFeedUrl(version, baseUrl)}/${assetName}`;
            const response = await fetch(url, {
                method: 'HEAD',
                signal: AbortSignal.timeout(METADATA_REQUEST_TIMEOUT_MS),
            });
            if (response.status === 404) {
                continue;
            }
            if (!response.ok) {
                throw new Error(`Updater metadata probe responded with ${response.status}`);
            }
            resolvedReleaseFeedBaseUrl = baseUrl;
            return true;
        } catch (error) {
            errors.push(`${baseUrl}: ${getErrorMessage(error)}`);
        }
    }
    if (errors.length === 2) {
        throw new Error(`All updater feeds failed (${errors.join('; ')})`);
    }
    return false;
}

function validateDownloadedUpdateForInstall(version: string) {
    const currentVersion = getCurrentVersion();
    if (!currentVersion || compareVersions(version, currentVersion) <= 0) {
        throw new Error(`Downloaded update ${version} is not newer than the running version ${currentVersion ?? 'unknown'}`);
    }
}

function clearDownloadedCandidate(version: string) {
    if (downloadedVersion === version) {
        downloadedVersion = null;
    }
    if (pendingVersion === version) {
        pendingVersion = null;
    }
    if (approvedDownloadAndInstallVersion === version) {
        approvedDownloadAndInstallVersion = null;
    }
}

function discardDownloadedCandidateIfNotNewer(context: string) {
    if (!downloadedVersion) {
        return false;
    }
    const currentVersion = getCurrentVersion();
    if (!currentVersion || compareVersions(downloadedVersion, currentVersion) > 0) {
        return false;
    }

    const invalidVersion = downloadedVersion;
    clearDownloadedCandidate(invalidVersion);
    logger.warn(
        `Discarding downloaded update ${invalidVersion} during ${context}; running version is ${currentVersion}`,
    );
    return true;
}

async function maybeClearSupersededDownloadedVersion() {
    if (!downloadedVersion) {
        return false;
    }

    try {
        const latestVersion = await fetchLatestMetadataVersion();
        const comparison = compareVersions(latestVersion, downloadedVersion);
        if (comparison < 0) {
            logger.warn(
                `Discarding cached downloaded update ${downloadedVersion}; current metadata rolled back to ${latestVersion}`,
            );
            downloadedVersion = null;
            pendingVersion = latestVersion;
            return true;
        }

        if (comparison === 0) {
            if (!await hasUpdaterMetadataForVersion(downloadedVersion)) {
                logger.warn(
                    `Discarding cached downloaded update ${downloadedVersion}; its updater feed is no longer published`,
                );
                downloadedVersion = null;
                pendingVersion = null;
                return true;
            }
            return false;
        }

        if (!await hasUpdaterMetadataForVersion(latestVersion)) {
            logger.info(
                `Keeping cached downloaded update ${downloadedVersion}; newer release ${latestVersion} has no ${getUpdaterMetadataAssetName()} updater feed`,
            );
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
    if (isShuttingDown) {
        return;
    }
    if (!isUpdaterRuntimeSupported()) {
        return;
    }

    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    const baseInterval = clamp(config.updates.pollIntervalMs, MIN_POLL_INTERVAL_MS, Number.POSITIVE_INFINITY);
    const jitter = Math.round(baseInterval * ((Math.random() * 2 * MAX_JITTER_RATIO) - MAX_JITTER_RATIO));
    const delay = clamp(baseInterval + jitter, MIN_POLL_INTERVAL_MS, Number.POSITIVE_INFINITY);

    pollTimer = schedulePollTimer(delay, 'Automatic update poll failed');
}

function schedulePollTimer(delayMs: number, failureLogPrefix: string) {
    return setTimeout(() => {
        if (isShuttingDown) {
            return;
        }
        void checkForUpdates('auto')
            .catch((error) => {
                logger.error(`${failureLogPrefix}: ${getErrorMessage(error)}`);
            })
            .finally(() => {
                if (!isShuttingDown) {
                    scheduleNextPoll();
                }
            });
    }, delayMs);
}

function setAutoUpdaterListeners() {
    if (listenersRegistered) {
        return;
    }
    listenersRegistered = true;
    autoUpdater.autoDownload = false;
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
        const normalizedVersion = normalizeVersion(info.version);
        const version = normalizedVersion.length > 0 ? normalizedVersion : pendingVersion;
        pendingVersion = version && version.length > 0 ? version : null;
        updateStatus({
            phase: 'available',
            origin: currentCheckOrigin,
            version: version && version.length > 0 ? version : null,
            percent: null,
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
            version: normalizeVersion(info.version) || getCurrentVersion(),
            percent: null,
            message: null,
        });
    };
    autoUpdater.on('update-not-available', onUpdateNotAvailable);
    autoUpdaterListenerUnsubscribe.push(() => {
        autoUpdater.removeListener('update-not-available', onUpdateNotAvailable);
    });

    const onUpdaterError = (error: unknown) => {
        approvedDownloadAndInstallVersion = null;
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
            const normalizedVersion = normalizeVersion(event.version);
            const version = normalizedVersion.length > 0 ? normalizedVersion : pendingVersion;
            pendingVersion = version && version.length > 0 ? version : null;
            downloadedVersion = version && version.length > 0 ? version : null;

            if (discardDownloadedCandidateIfNotNewer('download event')) {
                if (currentCheckOrigin === 'manual') {
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

            if (approvedDownloadAndInstallVersion) {
                const approvedVersion = approvedDownloadAndInstallVersion;
                approvedDownloadAndInstallVersion = null;

                if (version !== approvedVersion) {
                    if (version) {
                        clearDownloadedCandidate(version);
                    }
                    const message = `Downloaded update ${version ?? 'unknown'} did not match approved version ${approvedVersion}`;
                    logger.error(message);
                    updateStatus({
                        phase: 'error',
                        origin: 'manual',
                        version: approvedVersion,
                        percent: null,
                        message,
                    });
                    return;
                }

                await installDownloadedUpdate();
                return;
            }

            updateStatus({
                phase: 'downloaded',
                origin: currentCheckOrigin,
                version: version && version.length > 0 ? version : null,
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

async function resolveUpdaterCheckDecision(): Promise<IUpdaterCheckDecision> {
    const currentVersion = normalizeVersion(resolveApplicationVersion(app));
    let latestVersion: string;
    resolvedReleaseFeedBaseUrl = GITHUB_RELEASE_DOWNLOAD_BASE_URL;

    try {
        latestVersion = await fetchLatestMetadataVersion();
    } catch (error) {
        const message = isAbortError(error)
            ? 'Timed out while checking for updates.'
            : getErrorMessage(error);
        logger.warn(`Unable to query update metadata: ${message}`);
        return {
            shouldCheck: true,
            targetVersion: null,
        };
    }

    if (compareVersions(latestVersion, currentVersion) <= 0) {
        pendingVersion = null;
        return {
            shouldCheck: false,
            targetVersion: null,
        };
    }

    const suppressedVersion = await getSuppressedUpdateVersion(currentVersion);
    if (suppressedVersion === latestVersion) {
        logger.error(`Suppressing update ${latestVersion} after repeated startup failures; install a newer candidate or update manually`);
        pendingVersion = null;
        return {
            shouldCheck: false,
            targetVersion: null,
        };
    }

    try {
        if (!await hasUpdaterMetadataForVersion(latestVersion)) {
            logger.info(`Release ${latestVersion} has no ${getUpdaterMetadataAssetName()} updater feed; skipping in-app updater check`);
            pendingVersion = null;
            return {
                shouldCheck: false,
                targetVersion: null,
            };
        }
    } catch (error) {
        const message = isAbortError(error)
            ? 'Timed out while checking updater metadata.'
            : getErrorMessage(error);
        logger.warn(`Unable to verify updater metadata for ${latestVersion}: ${message}`);
        return {
            shouldCheck: true,
            targetVersion: null,
        };
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
        return {
            shouldCheck: false,
            targetVersion: null,
        };
    }

    pendingVersion = latestVersion;
    return {
        shouldCheck: true,
        targetVersion: latestVersion,
    };
}

async function checkForUpdates(origin: TAppUpdateCheckOrigin) {
    try {
        if (isShuttingDown) {
            return;
        }
        if (!isUpdaterRuntimeSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: getCurrentVersion(),
                    percent: null,
                    message: getUnsupportedRuntimeMessage(),
                });
            }
            return;
        }
        if (!await ensureUpdaterSupported()) {
            if (origin === 'manual') {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'manual',
                    version: getCurrentVersion(),
                    percent: null,
                    message: 'Updates require a signed packaged build.',
                });
            } else {
                updateStatus({
                    phase: 'unsupported',
                    origin: 'auto',
                    version: getCurrentVersion(),
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
                    return await checkForUpdates('manual');
                }
            }
            return;
        }

        discardDownloadedCandidateIfNotNewer('update check');
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
            const decision = await resolveUpdaterCheckDecision();
            if (!decision.shouldCheck) {
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
                // The rollout endpoint is the source of truth for the eligible
                // release. Point electron-updater at that release's directory
                // so GitHub's independently mutable `latest` pointer cannot
                // make a stale client download an intermediate version first.
                configureUpdaterFeed(decision.targetVersion);
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
    isShuttingDown = false;
    emitStatus = onStatus;
    emitStatus(status);

    if (initialized) {
        return;
    }
    initialized = true;

    const currentVersion = getCurrentVersion();
    if (currentVersion) {
        runDetached(
            async () => {
                const marker = await recordPendingUpdateStartup(currentVersion);
                if (marker && !marker.installationApplied) {
                    const message = `Update ${marker.pendingVersion} could not be installed; version ${currentVersion} was relaunched`;
                    logger.error(message);
                    updateStatus({
                        phase: 'error',
                        origin: 'manual',
                        version: marker.pendingVersion,
                        percent: null,
                        message,
                    });
                } else if (marker && marker.startupAttempts >= UPDATE_STARTUP_FAILURE_THRESHOLD) {
                    logger.error(
                        `Update ${currentVersion} failed to reach renderer readiness on ${marker.startupAttempts} consecutive startups`,
                    );
                }
            },
            {
                label: 'record pending update startup',
                logger,
            },
        );
    }

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
    pollTimer = schedulePollTimer(initialDelayMs, 'Initial automatic update check failed');
}

export async function triggerManualUpdateCheck() {
    if (isShuttingDown) {
        return { started: false };
    }
    await checkForUpdates('manual');
    return { started: true };
}

// fallow-ignore-next-line unused-export
export function getUpdateStatus() {
    if (status.version !== null) {
        return status;
    }
    return {
        ...status,
        version: getCurrentVersion(),
    };
}

export function downloadAvailableUpdate() {
    if (isShuttingDown || !pendingVersion || downloadedVersion || currentDownloadPromise) {
        return { started: false };
    }

    const candidateVersion = pendingVersion;
    approvedDownloadAndInstallVersion = candidateVersion;
    currentCheckOrigin = 'manual';
    updateStatus({
        phase: 'downloading',
        origin: 'manual',
        version: candidateVersion,
        percent: 0,
        message: null,
    });

    const downloadCancellationToken = new CancellationToken();
    currentDownloadCancellationToken = downloadCancellationToken;
    currentDownloadPromise = Promise.resolve()
        .then(() => {
            if (isShuttingDown || downloadCancellationToken.cancelled) {
                return;
            }
            return autoUpdater.downloadUpdate(downloadCancellationToken);
        })
        .then(() => undefined)
        .catch((error) => {
            if (isShuttingDown || downloadCancellationToken.cancelled) {
                return;
            }
            if (approvedDownloadAndInstallVersion === candidateVersion) {
                approvedDownloadAndInstallVersion = null;
            }
            const message = getErrorMessage(error);
            logger.error(`downloadUpdate failed: ${message}`);
            updateStatus({
                phase: 'error',
                origin: 'manual',
                version: candidateVersion,
                percent: null,
                message,
            });
        })
        .finally(() => {
            downloadCancellationToken.dispose();
            if (currentDownloadCancellationToken === downloadCancellationToken) {
                currentDownloadCancellationToken = null;
            }
            currentDownloadPromise = null;
        });

    return { started: true };
}

export async function installDownloadedUpdate() {
    if (!downloadedVersion) {
        return { started: false };
    }

    const candidateVersion = downloadedVersion;

    // Installation is always user-initiated, so errors must surface to the UI
    currentCheckOrigin = 'manual';

    try {
        validateDownloadedUpdateForInstall(candidateVersion);
    } catch (error) {
        clearDownloadedCandidate(candidateVersion);
        const message = `Downloaded update validation failed: ${getErrorMessage(error)}`;
        logger.error(message);
        updateStatus({
            phase: 'error',
            origin: 'manual',
            version: candidateVersion,
            percent: null,
            message,
        });
        return { started: false };
    }

    try {
        await writeSkippedVersion(null);
    } catch (error) {
        logger.warn(`Failed to clear skipped update version before install: ${getErrorMessage(error)}`);
    }
    try {
        await markUpdateInstallPending(candidateVersion);
    } catch (error) {
        logger.warn(`Failed to write update health marker before install: ${getErrorMessage(error)}`);
    }
    requestUpdateInstallShutdown(() => {
        autoUpdater.quitAndInstall(false, true);
    });
    return { started: true };
}

// fallow-ignore-next-line unused-export
export function deferDownloadedUpdate() {
    const candidateVersion = downloadedVersion ?? pendingVersion;
    if (!candidateVersion) {
        return;
    }

    approvedDownloadAndInstallVersion = null;

    updateStatus({
        phase: 'idle',
        origin: 'manual',
        version: candidateVersion,
        percent: null,
        message: null,
    });
}

// fallow-ignore-next-line unused-export
export async function skipUpdateVersion(version: string) {
    const normalized = normalizeVersion(version);
    if (!normalized) {
        return;
    }

    await writeSkippedVersion(normalized);
    approvedDownloadAndInstallVersion = null;
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
    isShuttingDown = true;
    approvedDownloadAndInstallVersion = null;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    clearProgressBroadcastTimer();
    lastProgressBroadcastAt = 0;
    currentDownloadCancellationToken?.cancel();

    if (currentCheckPromise) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                currentCheckPromise,
                new Promise<void>((resolve) => {
                    timeoutHandle = setTimeout(resolve, UPDATER_SHUTDOWN_CHECK_WAIT_TIMEOUT_MS);
                    timeoutHandle.unref?.();
                }),
            ]);
        } catch {
            // Ignore in-flight check failures during shutdown.
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    if (currentDownloadPromise) {
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                currentDownloadPromise,
                new Promise<void>((resolve) => {
                    timeoutHandle = setTimeout(resolve, UPDATER_SHUTDOWN_DOWNLOAD_WAIT_TIMEOUT_MS);
                    timeoutHandle.unref?.();
                }),
            ]);
        } catch {
            // Ignore in-flight download failures during shutdown.
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
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
