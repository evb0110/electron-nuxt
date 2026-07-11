#!/usr/bin/env node

import {
    execFile,
    execFileSync,
    spawn,
} from 'node:child_process';
import {access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const pdfPath = resolve(process.argv[2] ?? 'tests/fixtures/electron/generated-text.pdf');
const qpdf = process.env.QPDF_PATH ?? 'qpdf';
const maxRefs = Number.parseInt(process.env.EVB_TARGETED_XREF_RSS_REFS ?? '128', 10);
const maxGrowthBytes = Number.parseInt(
    process.env.EVB_TARGETED_XREF_MAX_RSS_GROWTH_BYTES ?? `${96 * 1024 * 1024}`,
    10,
);

await access(pdfPath);
const xref = execFileSync(qpdf, [
    '--show-xref',
    pdfPath,
], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
});
const refs = Array.from(xref.matchAll(/^(\d+)\/(\d+):/gmu), match => `${match[1]} ${match[2]} R`)
    .slice(0, Math.max(1, maxRefs));
if (refs.length === 0) {
    throw new Error('The PDF contains no xref entries to validate');
}

async function readResidentBytes(pid) {
    try {
        const {stdout} = await execFileAsync('ps', [
            '-o',
            'rss=',
            '-p',
            String(pid),
        ], {encoding: 'utf8'});
        const kib = Number.parseInt(stdout.trim(), 10);
        return Number.isFinite(kib) ? kib * 1024 : 0;
    } catch {
        return 0;
    }
}

async function validateRef(ref) {
    const [
        objectNumber,
        generationNumber,
    ] = ref.split(' ');
    const child = spawn(qpdf, [
        `--show-object=${objectNumber},${generationNumber}`,
        pdfPath,
    ], {stdio: 'ignore'});
    let peakCombinedRss = process.memoryUsage.rss();
    const sampler = setInterval(() => {
        void readResidentBytes(child.pid).then((childRss) => {
            peakCombinedRss = Math.max(peakCombinedRss, process.memoryUsage.rss() + childRss);
        });
    }, 5);
    try {
        const exitCode = await new Promise((resolveExit, reject) => {
            child.once('error', reject);
            child.once('exit', code => resolveExit(code));
        });
        if (exitCode !== 0) {
            throw new Error(`qpdf targeted validation failed for ${ref} (${exitCode})`);
        }
        return peakCombinedRss;
    } finally {
        clearInterval(sampler);
    }
}

const baselineRss = process.memoryUsage.rss();
let peakRss = baselineRss;
for (const ref of refs) {
    peakRss = Math.max(peakRss, await validateRef(ref));
}
const growthBytes = peakRss - baselineRss;
const result = {
    pdfPath,
    refsValidated: refs.length,
    baselineRss,
    peakRss,
    growthBytes,
    maxGrowthBytes,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (growthBytes > maxGrowthBytes) {
    throw new Error(`Targeted xref validation RSS grew by ${growthBytes} bytes; limit is ${maxGrowthBytes}`);
}
