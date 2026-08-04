import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {resolveCliNativeToolPath} from '@scripts/scanCleanupCliAdapters';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    resolveEffectiveScanCleanupOptions,
    sha256ScanCleanupFile,
} from '@scan-cleanup-core/index';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const auditScript = join(projectRoot, 'scripts/diagnostics/scan-cleanup-word-loss-audit.mjs');
const qpdfBinary = resolveCliNativeToolPath('qpdf', 'qpdf', projectRoot) ?? 'qpdf';

function buildMinimalPdf() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 32 32] /Resources << >> >>',
        '<< /Producer (evb-viewer-test) >>',
    ];
    let body = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((content, index) => {
        offsets.push(body.length);
        body += `${String(index + 1)} 0 obj\n${content}\nendobj\n`;
    });
    const xrefOffset = body.length;
    body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
}

interface IQpdfJsonEntry {[key: string]: unknown;}

interface IQpdfJson {qpdf: IQpdfJsonEntry[];}

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckleLevel: 'normal',
    autoDewarp: false,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

async function runAudit(source: string, cleaned: string, output: string) {
    try {
        await execFileAsync(process.execPath, [
            auditScript,
            '--source',
            source,
            '--cleaned',
            cleaned,
            '--verify-stamp',
            '--out',
            output,
            '--workers',
            '1',
        ], {
            cwd: projectRoot,
            maxBuffer: 2 * 1024 * 1024,
        });
        return 0;
    } catch (error) {
        return (error as {code?: number}).code ?? 1;
    }
}

async function injectStamp(source: string, output: string, stampHex: string, updatePath: string) {
    const qpdfJson = JSON.parse(
        (await execFileAsync(qpdfBinary, [
            '--json',
            '--object-streams=disable',
            source,
            '-',
        ])).stdout,
    ) as IQpdfJson;
    const trailerEntry = qpdfJson.qpdf.find(entry => entry.trailer !== undefined);
    const trailer = trailerEntry?.trailer as IQpdfJsonEntry | undefined;
    const trailerValue = trailer?.value as IQpdfJsonEntry | undefined;
    const infoReference = trailerValue?.['/Info'];
    if (typeof infoReference !== 'string') throw new Error('test PDF has no qpdf Info reference');
    const infoEntry = qpdfJson.qpdf.find(entry => Object.hasOwn(entry, `obj:${infoReference}`));
    const infoObject = infoEntry?.[`obj:${infoReference}`] as IQpdfJsonEntry | undefined;
    const infoValue = infoObject?.value as IQpdfJsonEntry | undefined;
    if (infoValue === undefined) throw new Error('test PDF has no qpdf Info object');
    infoValue['/EVBScanCleanup'] = `u:${stampHex}`;
    await writeFile(updatePath, JSON.stringify(qpdfJson));
    await execFileAsync(qpdfBinary, [
        `--update-from-json=${updatePath}`,
        source,
        output,
    ]);
}

describe('scan-cleanup word-loss audit stamp verification', () => {
    it('reports an unstamped baseline and accepts a qpdf-injected core stamp', async () => {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-stamp-audit-'));
        try {
            const source = join(temporaryDirectory, 'source.pdf');
            const cleaned = join(temporaryDirectory, 'cleaned.pdf');
            const update = join(temporaryDirectory, 'update.json');
            const baselineReport = join(temporaryDirectory, 'baseline.json');
            const stampedReport = join(temporaryDirectory, 'stamped.json');
            await writeFile(source, buildMinimalPdf());

            expect(await runAudit(source, source, baselineReport)).toBe(1);
            expect(JSON.parse(await readFile(baselineReport, 'utf8')).stampVerification).toMatchObject({status: 'unstamped'});

            const resolved = resolveEffectiveScanCleanupOptions({
                options,
                pageOverride: createScanCleanupPageOverride(),
                dpi: 300,
                qualityPath: 'raster',
            });
            const effectiveRecord = {
                sourcePage: 1,
                options: materializeScanCleanupStampOptions({
                    nativeOptions: resolved,
                    options,
                    qualityPath: 'raster',
                }),
            };
            const stamp = buildScanCleanupProvenanceStamp({
                sourceSha256: await sha256ScanCleanupFile(source),
                effectiveOptions: [effectiveRecord],
                outputMappings: [{
                    sourcePage: 1,
                    half: 'full',
                    outputOrdinal: 1,
                    rotationDegrees: 0,
                    excluded: false,
                    blank: false,
                }],
                pagePlanDigests: [buildScanCleanupPagePlanDigest(
                    1,
                    effectiveRecord.options,
                    {sourcePage: 1},
                )],
                buildIds: {
                    coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                    coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                    nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                    assemblerBackend: 'source-preserved',
                    transportMode: 'source-preserved',
                },
            });
            await injectStamp(
                source,
                cleaned,
                encodeScanCleanupProvenanceStampHex(stamp),
                update,
            );

            expect(await runAudit(source, cleaned, stampedReport)).toBe(0);
            expect(JSON.parse(await readFile(stampedReport, 'utf8')).stampVerification).toMatchObject({status: 'valid'});
        } finally {
            await rm(temporaryDirectory, {
                force: true,
                recursive: true,
            });
        }
    }, 30_000);
});
