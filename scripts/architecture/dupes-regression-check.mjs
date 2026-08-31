import { execFileSync } from 'node:child_process';
import {
    existsSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
    createDupesBaseline,
    decodeDupesBaseline,
    findNewCloneGroups,
} from './dupesRegressionPolicy.mjs';

const projectRoot = resolve(import.meta.dirname, '../..');
const baselinePath = resolve(projectRoot, '.fallow-dupes-baseline.json');

const shouldWriteBaseline = process.argv.slice(2).includes('--write-baseline');

if (!existsSync(baselinePath) && !shouldWriteBaseline) {
    console.error('Duplication baseline missing: .fallow-dupes-baseline.json');
    console.error('Regenerate with: pnpm run fallow:dupes -- --write-baseline');
    process.exit(1);
}

const raw = execFileSync('pnpm', [
    'exec',
    'fallow',
    'dupes',
    '--production',
    '--threshold',
    '10',
    '--format',
    'json',
], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});

const report = JSON.parse(raw);

if (shouldWriteBaseline) {
    const baseline = createDupesBaseline(report);
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
    console.log(`Wrote ${baseline.clone_signatures.length} stable clone signatures to .fallow-dupes-baseline.json.`);
    process.exit(0);
}

const baseline = decodeDupesBaseline(JSON.parse(readFileSync(baselinePath, 'utf8')));
const newGroups = findNewCloneGroups(report, baseline);

if (newGroups.length === 0) {
    console.log('Duplication regression check passed: no new clone groups beyond baseline.');
    process.exit(0);
}

console.error(`Duplication regression check failed: ${newGroups.length} new clone group(s) beyond baseline.`);
for (const group of newGroups) {
    for (const instance of group.instances ?? []) {
        console.error(`  ${instance.file}:${instance.start_line}-${instance.end_line}`);
    }
    console.error('');
}
console.error('Deduplicate the new clones, or if intentional refresh the baseline with: pnpm run fallow:dupes -- --write-baseline');
process.exit(1);
