import {
    runNativeToolCommand,
    type IRunNativeToolCommandOptions,
} from '@electron/native-tools/runNativeToolCommand';
import { compact } from 'es-toolkit/array';
import { getErrorMessage } from '@electron/utils/error';

export type TSourceDpiLog = (level: 'debug' | 'warn' | 'error', message: string) => void;

const PDFIMAGES_TIMEOUT_MS = 30 * 1000;
const PDFIMAGES_SAMPLE_TIMEOUT_MS = 5 * 1000;
const PDFIMAGES_MAX_CONTIGUOUS_PROBE_SPAN = 48;
const PDFIMAGES_MAX_SAMPLED_PAGES = 12;

export interface ISourceDpiDetectionResult {
    documentDpi: number | null;
    pageDpiByNumber: Map<number, number>;
}

interface IPdfImagesProbe {
    args: string[];
    timeoutMs: number;
    label: string;
    contributesDocumentDpi: boolean;
}

function getUniqueValidPages(pages: readonly number[] | undefined) {
    return Array.from(new Set((pages ?? []).filter(pageNumber =>
        Number.isSafeInteger(pageNumber) && pageNumber > 0,
    ))).sort((a, b) => a - b);
}

function getPageProbeRange(pages: readonly number[]) {
    if (pages.length === 0) {
        return null;
    }

    return {
        firstPage: pages[0] ?? 1,
        lastPage: pages[pages.length - 1] ?? 1,
    };
}

function getEvenlySpacedSample(pages: readonly number[]) {
    if (pages.length <= PDFIMAGES_MAX_SAMPLED_PAGES) {
        return [...pages];
    }

    const lastIndex = pages.length - 1;
    const sampledPages = new Set<number>();
    for (let sampleIndex = 0; sampleIndex < PDFIMAGES_MAX_SAMPLED_PAGES; sampleIndex += 1) {
        const pageIndex = Math.round((sampleIndex / (PDFIMAGES_MAX_SAMPLED_PAGES - 1)) * lastIndex);
        const pageNumber = pages[pageIndex];
        if (pageNumber !== undefined) {
            sampledPages.add(pageNumber);
        }
    }
    return Array.from(sampledPages).sort((a, b) => a - b);
}

function buildPdfImagesListArgs(pdfPath: string, firstPage: number, lastPage: number) {
    return [
        '-f',
        String(firstPage),
        '-l',
        String(lastPage),
        '-list',
        pdfPath,
    ];
}

function buildPdfImagesProbes(pdfPath: string, pages: readonly number[] | undefined): IPdfImagesProbe[] {
    const validPages = getUniqueValidPages(pages);
    if (validPages.length === 0) {
        return [{
            args: [
                '-list',
                pdfPath,
            ],
            timeoutMs: PDFIMAGES_TIMEOUT_MS,
            label: 'full-document',
            contributesDocumentDpi: true,
        }];
    }

    const pageRange = getPageProbeRange(validPages);
    if (!pageRange) {
        return [];
    }

    const pageSpan = pageRange.lastPage - pageRange.firstPage + 1;
    if (pageSpan <= PDFIMAGES_MAX_CONTIGUOUS_PROBE_SPAN) {
        return [{
            args: buildPdfImagesListArgs(pdfPath, pageRange.firstPage, pageRange.lastPage),
            timeoutMs: PDFIMAGES_TIMEOUT_MS,
            label: `${pageRange.firstPage}-${pageRange.lastPage}`,
            contributesDocumentDpi: true,
        }];
    }

    return getEvenlySpacedSample(validPages).map(pageNumber => ({
        args: buildPdfImagesListArgs(pdfPath, pageNumber, pageNumber),
        timeoutMs: PDFIMAGES_SAMPLE_TIMEOUT_MS,
        label: String(pageNumber),
        contributesDocumentDpi: false,
    }));
}

function createRecoverablePdfImagesLog(log: TSourceDpiLog): TSourceDpiLog {
    return (level, message) => {
        log(level === 'error' ? 'debug' : level, message);
    };
}

function parsePdfImagesListOutput(output: string): ISourceDpiDetectionResult {
    const pageDpiByNumber = new Map<number, number>();
    const lines = compact(output.split(/\r?\n/).map(line => line.trim()));
    let documentDpi = 0;

    for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length < 14) {
            continue;
        }
        const pageNumber = parseInt(parts[0] ?? '', 10);
        const xPpi = parseInt(parts[12] ?? '', 10);
        const yPpi = parseInt(parts[13] ?? '', 10);
        const dpi = Math.max(
            Number.isFinite(xPpi) ? xPpi : 0,
            Number.isFinite(yPpi) ? yPpi : 0,
        );
        if (!Number.isFinite(pageNumber) || pageNumber <= 0 || dpi <= 0) {
            continue;
        }

        documentDpi = Math.max(documentDpi, dpi);
        pageDpiByNumber.set(pageNumber, Math.max(pageDpiByNumber.get(pageNumber) ?? 0, dpi));
    }

    return {
        documentDpi: documentDpi > 0 ? documentDpi : null,
        pageDpiByNumber,
    };
}

function mergeDpiDetectionResults(
    target: ISourceDpiDetectionResult,
    source: ISourceDpiDetectionResult,
) {
    target.documentDpi = Math.max(target.documentDpi ?? 0, source.documentDpi ?? 0) || null;
    for (const [
        pageNumber,
        dpi,
    ] of source.pageDpiByNumber) {
        target.pageDpiByNumber.set(pageNumber, Math.max(target.pageDpiByNumber.get(pageNumber) ?? 0, dpi));
    }
}

export async function detectSourceDpiDetails(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
): Promise<ISourceDpiDetectionResult> {
    if (!pdfimagesBinary) {
        return {
            documentDpi: null,
            pageDpiByNumber: new Map(),
        };
    }
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('PDF DPI detection aborted');
    }

    try {
        const combinedResult: ISourceDpiDetectionResult = {
            documentDpi: null,
            pageDpiByNumber: new Map(),
        };
        const probes = buildPdfImagesProbes(pdfPath, pages);
        for (const probe of probes) {
            const commandOptions: IRunNativeToolCommandOptions = {
                commandLabel: 'pdfimages(-list)',
                timeoutMs: probe.timeoutMs,
                log: createRecoverablePdfImagesLog(log),
            };
            if (commandEnv !== undefined) {
                commandOptions.env = commandEnv;
            }
            if (signal !== undefined) {
                commandOptions.signal = signal;
            }

            try {
                const result = await runNativeToolCommand(
                    pdfimagesBinary,
                    probe.args,
                    commandOptions,
                );
                const probeResult = parsePdfImagesListOutput(result.stdout);
                if (!probe.contributesDocumentDpi) {
                    probeResult.documentDpi = null;
                }
                mergeDpiDetectionResults(combinedResult, probeResult);
            } catch (err) {
                if (signal?.aborted) {
                    throw signal.reason instanceof Error ? signal.reason : err;
                }
                log('debug', `pdfimages detection failed for pages ${probe.label}: ${getErrorMessage(err)}`);
            }
        }
        return combinedResult;
    } catch (err) {
        if (signal?.aborted) {
            throw signal.reason instanceof Error ? signal.reason : err;
        }
        log('debug', `pdfimages detection failed: ${getErrorMessage(err)}`);
    }

    return {
        documentDpi: null,
        pageDpiByNumber: new Map(),
    };
}

export async function detectSourceDpi(
    pdfPath: string,
    pdfimagesBinary: string | undefined,
    log: TSourceDpiLog,
    commandEnv?: NodeJS.ProcessEnv,
    signal?: AbortSignal,
    pages?: readonly number[],
) {
    return (await detectSourceDpiDetails(
        pdfPath,
        pdfimagesBinary,
        log,
        commandEnv,
        signal,
        pages,
    )).documentDpi;
}
