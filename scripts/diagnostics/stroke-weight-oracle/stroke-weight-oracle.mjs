#!/usr/bin/env node

/**
 * Component-granularity stroke-weight oracle.
 *
 * This Node entry point delegates pixel work to the adjacent OpenCV
 * implementation. It owns the stable CLI, input validation, the calibrated
 * constants, the report schema, and the exit status. The helper reads either
 * the exact full-resolution JBIG2 foreground mask of each cleaned PDF page or
 * a rendered page image; it never thresholds a composite PDF render.
 *
 * Calibration provenance and the recorded red baseline live in README.md and
 * calibration/ beside this file.
 */

import {execFile} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {
    access,
    mkdir,
    writeFile,
} from 'node:fs/promises';
import {
    dirname,
    isAbsolute,
    relative,
    resolve,
} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const helperPath = resolve(scriptDirectory, 'stroke_weight_oracle.py');
const calibrationPath = resolve(scriptDirectory, 'calibration.json');
const renderedMetricsPath = resolve(scriptDirectory, '../scan-cleanup-rendered-metrics.py');

/**
 * Adjudicated on the Luther Vorwort specimen: see README.md. Changing any of
 * these values makes a report incomparable with the recorded baseline.
 */
const CALIBRATION = Object.freeze(JSON.parse(readFileSync(calibrationPath, 'utf8')));

const DEFAULT_IMAGE_DPI = CALIBRATION.calibrationDpi;
const PATH_FLAGS = new Set([
    '--out',
    '--pdf',
    '--rendered-metrics',
    '--summary',
]);
const NUMBER_FLAG_OPTIONS = {
    '--dpi': 'dpi',
    '--min-local': 'minLocal',
    '--ratio': 'ratio',
    '--window-mm': 'windowMm',
};

const usage = () => `Usage: node stroke-weight-oracle.mjs --out <report.json> (--pdf <cleaned.pdf> | --image <page.png> ...)

Inputs (exactly one kind):
  --pdf <path>          Cleaned PDF; each page's full-resolution JBIG2 mask is
                        measured.
  --image <path>        Rendered page image; repeat for several pages.

Options:
  --dpi <number>        Image-input resolution (default: ${DEFAULT_IMAGE_DPI}).
  --summary <json>      Conversion summary; supplies source-page/leaf mapping
                        for PDF input.
  --pages <list>        PDF output pages, e.g. 1-8,11 (default: all pages).
  --label <text>        Ref/build label stored in the report.
  --rendered-metrics <path>
                        scan-cleanup-rendered-metrics.py used for exact JBIG2
                        extraction (default: the tracked sibling script).
  --python <exe>        Python interpreter (default: $EVB_PYTHON or python3).
  --window-mm <number>  Local horizontal comparison radius (default: ${CALIBRATION.localWindowMm}).
  --ratio <number>      Offender/local-median threshold (default: ${CALIBRATION.offenderRatio}).
  --min-local <number>  Minimum components in local window (default: ${CALIBRATION.localWindowMinComponents}).
  --help                Show this text.

Exit status is 0 when every requested page is measured with zero offenders,
1 when the gate is red, and 2 for invalid input or measurement failure.`;

function parseArgs(argv) {
    const options = {
        dpi: DEFAULT_IMAGE_DPI,
        images: [],
        label: null,
        minLocal: CALIBRATION.localWindowMinComponents,
        out: null,
        pages: null,
        pdf: null,
        python: process.env.EVB_PYTHON ?? 'python3',
        ratio: CALIBRATION.offenderRatio,
        renderedMetrics: renderedMetricsPath,
        summary: null,
        windowMm: CALIBRATION.localWindowMm,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (flag === '--help' || flag === '-h') {
            return {
                ...options,
                help: true,
            };
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new Error(`${flag} requires a value`);
        }
        index += 1;
        if (flag === '--image') {
            options.images.push(resolve(value));
        } else if (PATH_FLAGS.has(flag)) {
            options[flag === '--rendered-metrics' ? 'renderedMetrics' : flag.slice(2)] = resolve(value);
        } else if (Object.hasOwn(NUMBER_FLAG_OPTIONS, flag)) {
            options[NUMBER_FLAG_OPTIONS[flag]] = Number(value);
        } else if (flag === '--label' || flag === '--pages' || flag === '--python') {
            options[flag.slice(2)] = value;
        } else {
            throw new Error(`Unknown argument: ${flag}`);
        }
    }
    if (!options.out) throw new Error('--out is required');
    if (Boolean(options.pdf) === (options.images.length > 0)) {
        throw new Error('exactly one of --pdf or --image inputs is required');
    }
    for (const flag of Object.keys(NUMBER_FLAG_OPTIONS)) {
        const value = options[NUMBER_FLAG_OPTIONS[flag]];
        if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be positive`);
    }
    if (!Number.isSafeInteger(options.minLocal)) throw new Error('--min-local must be an integer');
    return options;
}

function helperArguments(options) {
    const args = [
        helperPath,
        '--calibration',
        calibrationPath,
        '--window-mm',
        String(options.windowMm),
        '--ratio',
        String(options.ratio),
        '--min-local',
        String(options.minLocal),
    ];
    if (options.pdf) {
        args.push('--pdf', options.pdf, '--rendered-metrics', options.renderedMetrics);
        if (options.pages) args.push('--pages', options.pages);
        if (options.summary) args.push('--summary', options.summary);
    } else {
        args.push('--dpi', String(options.dpi));
        for (const image of options.images) args.push('--image', image);
    }
    return args;
}

async function measure(options) {
    await Promise.all([
        access(helperPath),
        options.pdf ? access(options.pdf) : Promise.resolve(),
        options.pdf ? access(options.renderedMetrics) : Promise.resolve(),
        options.summary ? access(options.summary) : Promise.resolve(),
        ...options.images.map(image => access(image)),
    ]);
    const {
        stdout,
        stderr,
    } = await execFileAsync(options.python, helperArguments(options), {maxBuffer: 256 * 1024 * 1024});
    if (stderr.trim()) process.stderr.write(stderr);
    const measurement = JSON.parse(stdout);
    for (const page of measurement.pages) {
        if (typeof page.imagePath === 'string') page.imagePath = reportPath(page.imagePath);
    }
    return measurement;
}

/** Keeps a committed baseline report free of machine-specific home paths. */
function reportPath(path) {
    if (path === null) {
        return null;
    }
    const relativePath = relative(process.cwd(), path);
    return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
        ? relativePath
        : path;
}

async function main() {
    let options;
    try {
        options = parseArgs(process.argv.slice(2));
        if (options.help) {
            process.stdout.write(`${usage()}\n`);
            return;
        }
        const measurement = await measure(options);
        const report = {
            schemaVersion: 3,
            oracle: 'component-ridge-width-local-line-median',
            label: options.label,
            inputs: {
                dpi: options.pdf ? null : options.dpi,
                images: options.images.map(reportPath),
                pdf: reportPath(options.pdf),
                summary: reportPath(options.summary),
            },
            calibration: {
                ...CALIBRATION,
                localWindowMm: options.windowMm,
                localWindowMinComponents: options.minLocal,
                offenderRatio: options.ratio,
            },
            ...measurement,
        };
        await mkdir(dirname(options.out), {recursive: true});
        await writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(report.summary)}\n`);
        if (!report.summary.gatePass) process.exitCode = 1;
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.stderr.write(`${usage()}\n`);
        process.exitCode = 2;
    }
}

await main();
