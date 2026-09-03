import {
    isFailurePresentation,
    type FailurePresentation,
} from '@app/composables/useFailureToast';
import type {ILiveDiagnosticLease} from '@app/utils/failureReporter';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export interface IRuntimeErrorReport {
    id: string;
    title: string;
    detail: string;
    source: string;
    count: number;
    occurredAt: number;
    failure: FailureReceipt | null;
    pendingDiagnostic?: ILiveDiagnosticLease | undefined;
}

interface ILegacyRuntimeErrorReportOptions {
    title: string;
    source: string;
    error: unknown;
    dedupeKey?: string;
}

function stringifyErrorForReport(error: unknown) {
    if (error instanceof Error) {
        return [
            `${error.name}: ${error.message}`,
            error.stack,
        ].filter(Boolean).join('\n\n');
    }
    if (typeof error === 'string') {
        return error.trim();
    }
    try {
        return JSON.stringify(error, null, 2);
    } catch {
        return String(error);
    }
}

function createReportKey(source: string, title: string, detail: string) {
    return `${source}\n${title}\n${detail}`;
}

export const useRuntimeErrorReports = () => {
    const reports = useState<IRuntimeErrorReport[]>('runtime-error-reports', () => []);

    function discardLease(lease: ILiveDiagnosticLease | undefined) {
        lease?.discard();
    }

    function createRetainedReport(
        report: IRuntimeErrorReport,
        existing: IRuntimeErrorReport | undefined,
    ) {
        let pendingDiagnostic = report.pendingDiagnostic;
        if (existing?.pendingDiagnostic?.isLive) {
            if (pendingDiagnostic && pendingDiagnostic !== existing.pendingDiagnostic) {
                discardLease(pendingDiagnostic);
            }
            pendingDiagnostic = existing.pendingDiagnostic;
        } else if (existing?.pendingDiagnostic) {
            discardLease(existing.pendingDiagnostic);
        }

        if (
            pendingDiagnostic
            && reports.value.some(candidate => (
                candidate.id !== existing?.id
                && candidate.pendingDiagnostic?.isLive
            ))
        ) {
            discardLease(pendingDiagnostic);
            pendingDiagnostic = undefined;
        }

        return {
            ...report,
            pendingDiagnostic,
        };
    }

    function addReport(report: IRuntimeErrorReport) {
        const existing = reports.value.find(candidate => candidate.id === report.id);
        if (existing) {
            const retainedReport = createRetainedReport(report, existing);
            const nextReports = [
                {
                    ...existing,
                    ...retainedReport,
                    count: existing.count + 1,
                    occurredAt: Date.now(),
                },
                ...reports.value.filter(candidate => candidate.id !== report.id),
            ].slice(0, 6);
            const retainedEventIds = new Set(
                nextReports
                    .map(candidate => candidate.pendingDiagnostic?.failure.eventId)
                    .filter(Boolean),
            );
            for (const candidate of reports.value) {
                const lease = candidate.pendingDiagnostic;
                if (lease && !retainedEventIds.has(lease.failure.eventId)) {
                    discardLease(lease);
                }
            }
            reports.value = nextReports;
            return;
        }

        const retainedReport = createRetainedReport(report, undefined);
        const nextReports = [
            retainedReport,
            ...reports.value,
        ].slice(0, 6);
        const retainedEventIds = new Set(
            nextReports
                .map(candidate => candidate.pendingDiagnostic?.failure.eventId)
                .filter(Boolean),
        );
        for (const candidate of reports.value) {
            const lease = candidate.pendingDiagnostic;
            if (lease && !retainedEventIds.has(lease.failure.eventId)) {
                discardLease(lease);
            }
        }
        reports.value = nextReports;
    }

    function clearPendingDiagnostic(id: string, expectedLease?: ILiveDiagnosticLease) {
        reports.value = reports.value.map(report => {
            if (
                report.id !== id
                || !report.pendingDiagnostic
                || expectedLease && report.pendingDiagnostic.failure.eventId !== expectedLease.failure.eventId
            ) {
                return report;
            }
            discardLease(report.pendingDiagnostic);
            return {
                ...report,
                pendingDiagnostic: undefined,
            };
        });
    }

    function discardPendingDiagnostics() {
        reports.value = reports.value.map(report => {
            if (!report.pendingDiagnostic) {
                return report;
            }
            discardLease(report.pendingDiagnostic);
            return {
                ...report,
                pendingDiagnostic: undefined,
            };
        });
    }

    function resendPendingDiagnosticOnce() {
        for (const report of reports.value) {
            const lease = report.pendingDiagnostic;
            if (!lease?.isLive) {
                continue;
            }
            if (!lease.resendOnceAfterGrant()) {
                return false;
            }
            clearPendingDiagnostic(report.id, lease);
            return true;
        }
        return false;
    }

    function reportRuntimeError(presentation: FailurePresentation): void;
    /** Remove this compatibility overload at the Phase 2 exit when the unclassified-code migration report reaches zero. */
    function reportRuntimeError(options: ILegacyRuntimeErrorReportOptions): void;
    function reportRuntimeError(
        presentationOrOptions: FailurePresentation | ILegacyRuntimeErrorReportOptions,
    ) {
        if (isFailurePresentation(presentationOrOptions)) {
            addReport({
                id: presentationOrOptions.failure.eventId,
                title: presentationOrOptions.title,
                detail: presentationOrOptions.description ?? '',
                source: presentationOrOptions.failure.code,
                count: 1,
                occurredAt: Date.now(),
                failure: presentationOrOptions.failure,
                pendingDiagnostic: presentationOrOptions.pendingDiagnostic,
            });
            return;
        }

        const options = presentationOrOptions;
        const detail = stringifyErrorForReport(options.error);
        if (!detail) {
            return;
        }

        const dedupeKey = options.dedupeKey?.trim();
        const key = dedupeKey && dedupeKey.length > 0
            ? dedupeKey
            : createReportKey(options.source, options.title, detail);
        addReport({
            id: key,
            title: options.title,
            detail,
            source: options.source,
            count: 1,
            occurredAt: Date.now(),
            failure: null,
        });
    }

    function dismissRuntimeErrorReport(id: string) {
        const report = reports.value.find(candidate => candidate.id === id);
        discardLease(report?.pendingDiagnostic);
        reports.value = reports.value.filter(report => report.id !== id);
    }

    function clearRuntimeErrorReports() {
        for (const report of reports.value) {
            discardLease(report.pendingDiagnostic);
        }
        reports.value = [];
    }

    return {
        reports,
        reportRuntimeError,
        dismissRuntimeErrorReport,
        clearRuntimeErrorReports,
        discardPendingDiagnostics,
        resendPendingDiagnosticOnce,
    };
};
