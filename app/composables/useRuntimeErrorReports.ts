export interface IRuntimeErrorReport {
    id: string;
    title: string;
    detail: string;
    source: string;
    count: number;
    occurredAt: number;
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

    function reportRuntimeError(options: {
        title: string;
        source: string;
        error: unknown;
        dedupeKey?: string;
    }) {
        const detail = stringifyErrorForReport(options.error);
        if (!detail) {
            return;
        }

        const dedupeKey = options.dedupeKey?.trim();
        const key = dedupeKey && dedupeKey.length > 0
            ? dedupeKey
            : createReportKey(options.source, options.title, detail);
        const existing = reports.value.find(report => report.id === key);
        if (existing) {
            existing.count += 1;
            existing.detail = detail;
            existing.occurredAt = Date.now();
            return;
        }

        reports.value = [
            {
                id: key,
                title: options.title,
                detail,
                source: options.source,
                count: 1,
                occurredAt: Date.now(),
            },
            ...reports.value,
        ].slice(0, 6);
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
