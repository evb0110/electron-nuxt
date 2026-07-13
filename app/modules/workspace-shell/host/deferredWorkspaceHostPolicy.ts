export const DEFERRED_WORKSPACE_HOST_POLICY = {
    RECENT_OPEN_LOG_SECTION: 'recent-open',
    LOADER_LOG_SECTION: 'loader',
    // A terminal open result is gated on a real initial visual. Large scanned
    // documents can legitimately take longer than a small UI polling budget,
    // so keep this aligned with the blocking real-app first-visual deadline.
    DOCUMENT_OPEN_SETTLE_TIMEOUT_MS: 30_000,
    WORKSPACE_MOUNT_POLL_INTERVAL_MS: 25,
    WORKSPACE_MOUNT_TIMEOUT_MS: 30_000,
    WORKSPACE_MOUNT_RETRY_TIMEOUT_MS: 20_000,
} as const;
