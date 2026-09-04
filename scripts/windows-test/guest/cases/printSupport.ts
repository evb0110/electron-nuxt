import { PDFDocument } from 'pdf-lib';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import type { IGuestFileSystem } from '@scripts/windows-test/guest/guestRuntime';
import type { ICaseContext } from '@scripts/windows-test/guest/cases/caseContext';
import { MICROSOFT_PRINT_TO_PDF_PRINTER } from '@scripts/windows-test/guest/native-ui/selectorRecords';

const PRINT_QUEUE_POLL_INTERVAL_MS = 500;

const FILE_SETTLE_POLL_INTERVAL_MS = 500;

export interface IPrintJobRecord {
    id: number;
    documentName: string;
    printerName: string;
    status: string;
    submittedTime: string | null;
}

export function isPrintJobRecord(value: unknown): value is IPrintJobRecord {
    return isRecord(value)
        && isFiniteNumber(value.id)
        && typeof value.documentName === 'string'
        && typeof value.printerName === 'string'
        && typeof value.status === 'string'
        && (value.submittedTime === null || typeof value.submittedTime === 'string');
}

export function parsePrintJobs(payload: unknown): IPrintJobRecord[] {
    if (payload === null || payload === undefined) {
        return [];
    }
    const candidates = Array.isArray(payload) ? payload : [payload];
    if (!candidates.every(isPrintJobRecord)) {
        throw new Error('get-print-jobs.ps1 returned an unrecognized payload');
    }
    return candidates;
}

export async function readPrintJobs(context: ICaseContext, printerName = MICROSOFT_PRINT_TO_PDF_PRINTER) {
    return parsePrintJobs(await context.powerShell.runJson('get-print-jobs.ps1', [
        '-PrinterName',
        printerName,
    ]));
}

export interface IPrintQueueDrainResult {
    drained: boolean;
    observedJobs: number;
    lastStatus: string | null;
}

export async function waitForPrintQueueDrain(
    context: ICaseContext,
    timeoutMs: number,
    printerName = MICROSOFT_PRINT_TO_PDF_PRINTER,
): Promise<IPrintQueueDrainResult> {
    const deadline = context.clock.now() + timeoutMs;
    let observedJobs = 0;
    let lastStatus: string | null = null;
    for (;;) {
        const jobs = await readPrintJobs(context, printerName);
        observedJobs = Math.max(observedJobs, jobs.length);
        lastStatus = jobs[0]?.status ?? lastStatus;
        if (jobs.length === 0) {
            return {
                drained: true,
                observedJobs,
                lastStatus,
            };
        }
        if (context.clock.now() >= deadline) {
            return {
                drained: false,
                observedJobs,
                lastStatus,
            };
        }
        await context.clock.sleep(PRINT_QUEUE_POLL_INTERVAL_MS);
    }
}

export interface IFileSettleResult {
    exists: boolean;
    bytes: number;
    /** True only when a non-empty file stopped growing before the deadline. */
    settled: boolean;
}

export async function waitForFileToSettle(
    context: ICaseContext,
    filePath: string,
    timeoutMs: number,
): Promise<IFileSettleResult> {
    const deadline = context.clock.now() + timeoutMs;
    let previousBytes = -1;
    for (;;) {
        if (await context.fs.exists(filePath)) {
            const { bytes } = await context.fs.stat(filePath);
            if (bytes > 0 && bytes === previousBytes) {
                return {
                    exists: true,
                    bytes,
                    settled: true,
                };
            }
            previousBytes = bytes;
        }
        if (context.clock.now() >= deadline) {
            return {
                exists: previousBytes >= 0,
                bytes: Math.max(previousBytes, 0),
                settled: false,
            };
        }
        await context.clock.sleep(FILE_SETTLE_POLL_INTERVAL_MS);
    }
}

export async function readPdfPageCount(fs: IGuestFileSystem, filePath: string) {
    const bytes = await fs.readBytes(filePath);
    const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
    return document.getPageCount();
}

export async function readPdfByteLength(fs: IGuestFileSystem, filePath: string) {
    return (await fs.stat(filePath)).bytes;
}
