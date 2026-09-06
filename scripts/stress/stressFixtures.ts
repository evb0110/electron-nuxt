import { createHash } from 'node:crypto';
import {
    copyFile,
    mkdir,
    open,
    readFile,
    stat,
    truncate,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    join,
    resolve,
} from 'node:path';
import {
    PDFDocument,
    PDFName,
    PDFString,
    StandardFonts,
} from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { requirePageIndex } from '@contracts/pageNumbers';
import { writePdfBookmarkOutlines } from '@pdf-core/writePdfBookmarkOutlines';
import {
    createLargeScannedFixturePdf,
    resolveDjvuFixturePath,
} from '@tests/e2e/electron/helpers/fixtures';
import type {
    TStressFixtureId,
    TStressFixtureKind,
} from '@scripts/stress/stressTypes';

export const STRESS_FIXTURE_GENERATOR_VERSION = 1;
export const DEFAULT_STRESS_FIXTURE_DIR = resolve(process.cwd(), '.devkit', 'stress', 'fixtures');

export interface IStressFixtureSpec {
    id: TStressFixtureId;
    kind: TStressFixtureKind;
    filename: string;
    description: string;
    params: Record<string, number | string>;
    expectedPageCount: number | null;
    /** Sparse fixtures are mostly zero bytes; the manifest records the logical size, not disk blocks. */
    approxBytes: number;
}

export interface IStressFixtureRecord {
    id: TStressFixtureId;
    path: string;
    bytes: number;
    specHash: string;
    generatedAt: string;
    available: boolean;
    reason: string | null;
}

export interface IStressFixtureManifest {
    schemaVersion: 1;
    generatorVersion: number;
    fixtures: Partial<Record<TStressFixtureId, IStressFixtureRecord>>;
}

const MIB = 1024 * 1024;

export const STRESS_FIXTURE_SPECS: Record<TStressFixtureId, IStressFixtureSpec> = {
    'xlarge-sparse-513mib': {
        id: 'xlarge-sparse-513mib',
        kind: 'pdf',
        filename: 'xlarge-sparse-513mib.pdf',
        description: 'Sparse-padded 513 MiB PDF (431 pages) that crosses the native-preview size threshold without storing a binary.',
        params: {
            pageCount: 431,
            targetBytes: 513 * MIB,
        },
        expectedPageCount: 431,
        approxBytes: 513 * MIB,
    },
    'many-pages-text-4000': {
        id: 'many-pages-text-4000',
        kind: 'pdf',
        filename: 'many-pages-text-4000.pdf',
        description: '4000 text pages; exercises page virtualization, page-box navigation and search over a wide page range.',
        params: {pageCount: 4000},
        expectedPageCount: 4000,
        approxBytes: 6 * MIB,
    },
    'dense-annotations-2000': {
        id: 'dense-annotations-2000',
        kind: 'pdf',
        filename: 'dense-annotations-2000.pdf',
        description: '200 pages with 10 embedded annotations each (Square, FreeText, Text); stresses the annotation inventory and layer rendering.',
        params: {
            pageCount: 200,
            annotationsPerPage: 10,
        },
        expectedPageCount: 200,
        approxBytes: 2 * MIB,
    },
    'deep-outline-3000': {
        id: 'deep-outline-3000',
        kind: 'pdf',
        filename: 'deep-outline-3000.pdf',
        description: '300 pages with a 3-level outline of 3000 bookmarks; stresses the sidebar outline tree.',
        params: {
            pageCount: 300,
            topLevel: 30,
            perLevel: 10,
        },
        expectedPageCount: 300,
        approxBytes: 1 * MIB,
    },
    'scanned-large-431': {
        id: 'scanned-large-431',
        kind: 'pdf',
        filename: 'scanned-large-431.pdf',
        description: 'Raster scanned-page fixture (431 JPEG pages plus a 28 MiB attachment) reused from the E2E fixture cache.',
        params: {
            pageCount: 431,
            attachmentBytes: 28 * MIB,
        },
        expectedPageCount: 431,
        approxBytes: 30 * MIB,
    },
    'text-small-12': {
        id: 'text-small-12',
        kind: 'pdf',
        filename: 'text-small-12.pdf',
        description: '12 text pages; control document for annotate/save flows and recovery after failures.',
        params: {pageCount: 12},
        expectedPageCount: 12,
        approxBytes: 64 * 1024,
    },
    'corrupt-truncated': {
        id: 'corrupt-truncated',
        kind: 'pdf',
        filename: 'corrupt-truncated.pdf',
        description: 'text-small-12 truncated to 60% so the xref table and trailer are missing.',
        params: {
            source: 'text-small-12',
            keepRatio: 0.6,
        },
        expectedPageCount: null,
        approxBytes: 40 * 1024,
    },
    'djvu-reference': {
        id: 'djvu-reference',
        kind: 'djvu',
        filename: 'reference.djvu',
        description: 'Tracked or corpus DjVu fixture resolved through the E2E DjVu availability rules.',
        params: {},
        expectedPageCount: null,
        approxBytes: 0,
    },
};

export const STRESS_FIXTURE_IDS = Object.keys(STRESS_FIXTURE_SPECS) as TStressFixtureId[];

export function isStressFixtureId(value: string): value is TStressFixtureId {
    return Object.hasOwn(STRESS_FIXTURE_SPECS, value);
}

export function computeStressFixtureSpecHash(spec: IStressFixtureSpec, generatorVersion = STRESS_FIXTURE_GENERATOR_VERSION) {
    const canonical = JSON.stringify({
        generatorVersion,
        id: spec.id,
        kind: spec.kind,
        params: Object.keys(spec.params).sort().map(key => [
            key,
            spec.params[key],
        ]),
    });
    return createHash('sha256').update(canonical).digest('hex');
}

function isFixtureRecord(value: unknown): value is IStressFixtureRecord {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record.id === 'string'
        && typeof record.path === 'string'
        && typeof record.bytes === 'number'
        && typeof record.specHash === 'string'
        && typeof record.available === 'boolean';
}

export function parseStressFixtureManifest(raw: string): IStressFixtureManifest {
    const parsed: unknown = JSON.parse(raw);
    const empty: IStressFixtureManifest = {
        schemaVersion: 1,
        generatorVersion: STRESS_FIXTURE_GENERATOR_VERSION,
        fixtures: {},
    };
    if (!parsed || typeof parsed !== 'object') {
        return empty;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.schemaVersion !== 1 || !candidate.fixtures || typeof candidate.fixtures !== 'object') {
        return empty;
    }
    const fixtures: IStressFixtureManifest['fixtures'] = {};
    for (const [
        key,
        value,
    ] of Object.entries(candidate.fixtures as Record<string, unknown>)) {
        if (isStressFixtureId(key) && isFixtureRecord(value)) {
            fixtures[key] = value;
        }
    }
    return {
        schemaVersion: 1,
        generatorVersion: typeof candidate.generatorVersion === 'number' ? candidate.generatorVersion : 0,
        fixtures,
    };
}

/**
 * A cached record is reusable only when the spec hash still matches and the
 * file on disk has the recorded size. Sparse files are never re-hashed: a
 * content hash of 513 MiB per run would cost more than regenerating.
 */
export async function isStressFixtureRecordReusable(record: IStressFixtureRecord | undefined, expectedSpecHash: string) {
    if (!record || !record.available || record.specHash !== expectedSpecHash) {
        return false;
    }
    try {
        const info = await stat(record.path);
        return info.isFile() && info.size === record.bytes;
    } catch {
        return false;
    }
}

async function readManifest(path: string) {
    try {
        return parseStressFixtureManifest(await readFile(path, 'utf8'));
    } catch {
        return {
            schemaVersion: 1,
            generatorVersion: STRESS_FIXTURE_GENERATOR_VERSION,
            fixtures: {},
        } satisfies IStressFixtureManifest;
    }
}

async function writeManifest(path: string, manifest: IStressFixtureManifest) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
}

async function createTextPagesDocument(pageCount: number, titlePrefix: string) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = doc.addPage([
            612,
            792,
        ]);
        page.drawText(`${titlePrefix} page ${pageNumber} of ${pageCount}`, {
            x: 54,
            y: 720,
            size: 18,
            font,
        });
        for (let line = 0; line < 20; line += 1) {
            page.drawText(`stress line ${line + 1} marker-${pageNumber}-${line + 1} lorem ipsum dolor sit amet`, {
                x: 54,
                y: 680 - line * 22,
                size: 10,
                font,
            });
        }
    }
    return doc;
}

async function generateManyPagesText(outputPath: string, pageCount: number) {
    const doc = await createTextPagesDocument(pageCount, 'EVB stress many-pages');
    await writeFile(outputPath, await doc.save({useObjectStreams: true}));
}

/**
 * Sparse padding keeps the last `startxref` valid: the base document is
 * written, the file is extended with a hole, and a trailer pointing at the
 * original xref offset is appended. Readers that scan backwards for
 * `%%EOF` accept it; the hole costs no disk blocks on APFS/ext4.
 */
export async function generateSparseXlargePdf(outputPath: string, pageCount: number, targetBytes: number) {
    const doc = await createTextPagesDocument(pageCount, 'EVB stress xlarge sparse');
    const note = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('FreeText'),
        Rect: [
            54,
            620,
            300,
            662,
        ],
        Contents: PDFString.of('EVB stress existing FreeText note'),
        DA: PDFString.of('/Helvetica 12 Tf 0 g'),
        F: 4,
    });
    doc.getPage(0).node.addAnnot(doc.context.register(note));
    const base = await doc.save({
        addDefaultPage: false,
        useObjectStreams: false,
    });
    const baseText = Buffer.from(base).toString('latin1');
    const startXref = [...baseText.matchAll(/startxref\s+(\d+)\s+%%EOF/gu)].at(-1)?.[1];
    if (startXref === undefined) {
        throw new Error('generated PDF has no startxref trailer');
    }
    const trailer = Buffer.from(`\nstartxref\n${startXref}\n%%EOF\n`, 'ascii');
    if (targetBytes < base.byteLength + trailer.byteLength) {
        throw new Error(`targetBytes must be at least ${base.byteLength + trailer.byteLength}`);
    }
    await writeFile(outputPath, base);
    const handle = await open(outputPath, 'r+');
    try {
        await handle.truncate(targetBytes);
        await handle.write(trailer, 0, trailer.byteLength, targetBytes - trailer.byteLength);
    } finally {
        await handle.close();
    }
}

async function generateDenseAnnotations(outputPath: string, pageCount: number, annotationsPerPage: number) {
    const doc = await createTextPagesDocument(pageCount, 'EVB stress dense annotations');
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const page = doc.getPage(pageIndex);
        for (let slot = 0; slot < annotationsPerPage; slot += 1) {
            const y = 80 + slot * 60;
            const variant = slot % 3;
            const rect = [
                320,
                y,
                560,
                y + 40,
            ];
            const common = {
                Type: PDFName.of('Annot'),
                Rect: rect,
                F: 4,
                Contents: PDFString.of(`stress annotation p${pageIndex + 1} #${slot + 1}`),
                T: PDFString.of('stress'),
            };
            const dict = variant === 0
                ? doc.context.obj({
                    ...common,
                    Subtype: PDFName.of('Square'),
                    C: [
                        1,
                        0,
                        0,
                    ],
                    IC: [
                        1,
                        1,
                        0,
                    ],
                })
                : variant === 1
                    ? doc.context.obj({
                        ...common,
                        Subtype: PDFName.of('FreeText'),
                        DA: PDFString.of('/Helvetica 10 Tf 0 0 1 rg'),
                    })
                    : doc.context.obj({
                        ...common,
                        Subtype: PDFName.of('Text'),
                        Name: PDFName.of('Comment'),
                        Open: false,
                    });
            page.node.addAnnot(doc.context.register(dict));
        }
    }
    await writeFile(outputPath, await doc.save({useObjectStreams: false}));
}

function buildOutlineEntries(pageCount: number, topLevel: number, perLevel: number) {
    const entries: IPdfBookmarkEntry[] = [];
    let counter = 0;
    const nextPage = () => {
        counter += 1;
        return requirePageIndex(counter % pageCount);
    };
    for (let top = 0; top < topLevel; top += 1) {
        const children: IPdfBookmarkEntry[] = [];
        for (let mid = 0; mid < perLevel; mid += 1) {
            const leaves: IPdfBookmarkEntry[] = [];
            for (let leaf = 0; leaf < perLevel; leaf += 1) {
                leaves.push({
                    title: `Section ${top + 1}.${mid + 1}.${leaf + 1}`,
                    pageIndex: nextPage(),
                    pageYRatio: null,
                    namedDest: null,
                    bold: false,
                    italic: leaf % 2 === 1,
                    color: null,
                    items: [],
                });
            }
            children.push({
                title: `Chapter ${top + 1}.${mid + 1}`,
                pageIndex: nextPage(),
                pageYRatio: null,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: leaves,
            });
        }
        entries.push({
            title: `Part ${top + 1}`,
            pageIndex: nextPage(),
            pageYRatio: null,
            namedDest: null,
            bold: true,
            italic: false,
            color: null,
            items: children,
        });
    }
    return entries;
}

async function generateDeepOutline(outputPath: string, pageCount: number, topLevel: number, perLevel: number) {
    const doc = await createTextPagesDocument(pageCount, 'EVB stress deep outline');
    writePdfBookmarkOutlines(doc, buildOutlineEntries(pageCount, topLevel, perLevel));
    await writeFile(outputPath, await doc.save({useObjectStreams: false}));
}

async function generateTruncatedCopy(sourcePath: string, outputPath: string, keepRatio: number) {
    const source = await stat(sourcePath);
    await copyFile(sourcePath, outputPath);
    await truncate(outputPath, Math.floor(source.size * keepRatio));
}

async function generateScannedLarge(outputPath: string, pageCount: number, attachmentBytes: number) {
    const generated = await createLargeScannedFixturePdf('stress-scanned-large.pdf', pageCount, attachmentBytes, 1);
    await copyFile(generated, outputPath);
}

function numberParam(spec: IStressFixtureSpec, key: string) {
    const value = spec.params[key];
    if (typeof value !== 'number') {
        throw new Error(`fixture ${spec.id} is missing numeric param '${key}'`);
    }
    return value;
}

export interface IEnsureStressFixturesOptions {
    rootDir?: string;
    log?: (line: string) => void;
}

/**
 * Generates (or reuses) the requested fixtures under a content-addressed
 * manifest. Order matters only for `corrupt-truncated`, which derives from
 * `text-small-12`, so that dependency is resolved first.
 */
export async function ensureStressFixtures(ids: readonly TStressFixtureId[], options: IEnsureStressFixturesOptions = {}) {
    const rootDir = options.rootDir ?? DEFAULT_STRESS_FIXTURE_DIR;
    const log = options.log ?? (() => {});
    await mkdir(rootDir, {recursive: true});
    const manifestPath = join(rootDir, 'manifest.json');
    const manifest = await readManifest(manifestPath);
    const results = new Map<TStressFixtureId, IStressFixtureRecord>();

    const ordered = [...new Set(ids)];
    if (ordered.includes('corrupt-truncated') && !ordered.includes('text-small-12')) {
        ordered.unshift('text-small-12');
    }
    ordered.sort((left, right) => (left === 'text-small-12' ? -1 : right === 'text-small-12' ? 1 : 0));

    for (const id of ordered) {
        const spec = STRESS_FIXTURE_SPECS[id];
        const specHash = computeStressFixtureSpecHash(spec);
        const cached = manifest.fixtures[id];
        if (await isStressFixtureRecordReusable(cached, specHash) && cached) {
            log(`fixture ${id}: reusing ${cached.path}`);
            results.set(id, cached);
            continue;
        }

        const outputPath = join(rootDir, spec.filename);
        let available = true;
        let reason: string | null = null;
        let finalPath = outputPath;
        log(`fixture ${id}: generating ${spec.description}`);
        switch (id) {
            case 'xlarge-sparse-513mib':
                await generateSparseXlargePdf(outputPath, numberParam(spec, 'pageCount'), numberParam(spec, 'targetBytes'));
                break;
            case 'many-pages-text-4000':
                await generateManyPagesText(outputPath, numberParam(spec, 'pageCount'));
                break;
            case 'dense-annotations-2000':
                await generateDenseAnnotations(outputPath, numberParam(spec, 'pageCount'), numberParam(spec, 'annotationsPerPage'));
                break;
            case 'deep-outline-3000':
                await generateDeepOutline(outputPath, numberParam(spec, 'pageCount'), numberParam(spec, 'topLevel'), numberParam(spec, 'perLevel'));
                break;
            case 'scanned-large-431':
                await generateScannedLarge(outputPath, numberParam(spec, 'pageCount'), numberParam(spec, 'attachmentBytes'));
                break;
            case 'text-small-12':
                await generateManyPagesText(outputPath, numberParam(spec, 'pageCount'));
                break;
            case 'corrupt-truncated': {
                const source = results.get('text-small-12');
                if (!source) {
                    throw new Error('corrupt-truncated requires text-small-12 to be generated first');
                }
                await generateTruncatedCopy(source.path, outputPath, numberParam(spec, 'keepRatio'));
                break;
            }
            case 'djvu-reference': {
                const availability = resolveDjvuFixturePath();
                if (availability.path) {
                    finalPath = availability.path;
                } else {
                    available = false;
                    reason = availability.reason;
                }
                break;
            }
        }

        const bytes = available ? (await stat(finalPath)).size : 0;
        const record: IStressFixtureRecord = {
            id,
            path: finalPath,
            bytes,
            specHash,
            generatedAt: new Date().toISOString(),
            available,
            reason,
        };
        manifest.fixtures[id] = record;
        results.set(id, record);
        await writeManifest(manifestPath, manifest);
    }

    return results;
}

export function describeStressFixtures() {
    return STRESS_FIXTURE_IDS.map((id) => {
        const spec = STRESS_FIXTURE_SPECS[id];
        return `${id} (${spec.kind}, ~${(spec.approxBytes / MIB).toFixed(1)} MiB): ${spec.description}`;
    }).join('\n');
}
