import {
    isFailurePresentation,
    type FailurePresentation,
} from '@app/composables/useFailureToast';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';

export interface IRuntimeErrorReport {
    id: string;
    title: string;
    detail: string;
    source: string;
    count: number;
    occurredAt: number;
    failure: FailureReceipt | null;
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

    function addReport(report: IRuntimeErrorReport) {
        const existing = reports.value.find(candidate => candidate.id === report.id);
        if (existing) {
            reports.value = [
                {
                    ...existing,
                    ...report,
                    count: existing.count + 1,
                    occurredAt: Date.now(),
                },
                ...reports.value.filter(candidate => candidate.id !== report.id),
            ].slice(0, 6);
            return;
        }

        reports.value = [
            report,
            ...reports.value,
        ].slice(0, 6);
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
        reports.value = reports.value.filter(report => report.id !== id);
    }

    function clearRuntimeErrorReports() {
        reports.value = [];
    }

    return {
        reports,
        reportRuntimeError,
        dismissRuntimeErrorReport,
        clearRuntimeErrorReports,
    };
};
