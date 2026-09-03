import type {DesktopDiagnosticDist} from '@contracts/diagnostics/desktopDiagnosticDists.js';

export type SentryDiagnosticEnvironment = 'production' | 'preview' | 'development' | 'test';
export type SentryBuildTarget = 'desktop' | 'web';
export type WebDiagnosticDist = 'production' | `preview-${string}`;

export interface SentryBuildIdentity {
    readonly target: SentryBuildTarget;
    readonly release: string;
    readonly dist: string;
    readonly environment: SentryDiagnosticEnvironment;
}

export declare const SENTRY_DESKTOP_RELEASE_NAME: 'evb-viewer-desktop';
export declare const SENTRY_WEB_RELEASE_NAME: 'evb-viewer-web';
export declare const SENTRY_DIAGNOSTIC_ENVIRONMENTS: readonly SentryDiagnosticEnvironment[];
export declare const SENTRY_WEB_PRODUCTION_DIST: 'production';

export declare function resolveSentryBuildTarget(
    environment?: Record<string, string | undefined>,
): SentryBuildTarget;
export declare function resolveDesktopDiagnosticDist(options?: {
    environment?: Record<string, string | undefined>;
    platform?: string;
    architecture?: string;
}): DesktopDiagnosticDist;
export declare function resolveWebDiagnosticDist(options?: {
    environment?: Record<string, string | undefined>;
    sentryEnvironment?: SentryDiagnosticEnvironment;
}): WebDiagnosticDist;
export declare function createSentryBuildIdentity(options: {
    target: SentryBuildTarget;
    version?: string;
    deployment?: string;
    release?: string;
    dist: string;
    environment: SentryDiagnosticEnvironment;
}): SentryBuildIdentity;
export declare function resolveSentryBuildIdentity(options?: {
    target?: SentryBuildTarget;
    version?: string | undefined;
    deployment?: string | undefined;
    release?: string | undefined;
    environment?: Record<string, string | undefined>;
    platform?: string;
    architecture?: string;
}): SentryBuildIdentity;
export declare function isSentryDiagnosticsBuild(
    environment?: Record<string, string | undefined>,
): boolean;
export declare function assertSentryBuildIdentity(value: unknown): SentryBuildIdentity;
export declare function sentryBuildIdentityKey(identity: SentryBuildIdentity): string;
export declare function assertSameSentryBuildIdentity(
    expected: SentryBuildIdentity,
    actual: SentryBuildIdentity,
): SentryBuildIdentity;
