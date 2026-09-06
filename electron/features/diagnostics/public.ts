export {
    captureMainFailure,
    createMainFailureReporter,
    createNoopMainDiagnosticsTransport,
    getMainFailureReporter,
    initializeMainFailureReporter,
    MAIN_DIAGNOSTICS_DEFAULT_BURST_LIMIT,
    MAIN_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS,
    MAIN_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS,
    MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
    setMainDiagnosticsPreference,
    waitForMainDiagnosticsTransportReady,
} from '@electron/features/diagnostics/mainFailureReporter';
export type {
    IMainDiagnosticsHealthSnapshot,
    IMainDiagnosticsTransport,
    IMainFailureReporter,
    IMainFailureReporterOptions,
    TMainDiagnosticsDropReason,
    TMainDiagnosticsPreference,
} from '@electron/features/diagnostics/mainFailureReporter';
