const PROGRESS_COMBINE_START = 88;
const PROGRESS_COMBINE_CAP = 94;

export function createCompactDjvuProgressHandler(
    totalPages: number,
    emitProgress: (percent: number) => void,
    onMalformedLine?: (line: string) => void,
) {
    let buffer = '';
    return (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/u);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                const payload = JSON.parse(line) as {
                    processed?: unknown;
                    total?: unknown
                };
                const processed = typeof payload.processed === 'number' ? payload.processed : 0;
                const total = typeof payload.total === 'number' && payload.total > 0
                    ? payload.total
                    : totalPages;
                emitProgress(PROGRESS_COMBINE_START + Math.round(
                    (processed / Math.max(1, total)) * (PROGRESS_COMBINE_CAP - PROGRESS_COMBINE_START),
                ));
            } catch {
                onMalformedLine?.(line);
            }
        }
    };
}
