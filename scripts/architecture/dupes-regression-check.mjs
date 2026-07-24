import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '../..');
const baselinePath = resolve(projectRoot, '.fallow-dupes-baseline.json');

if (!existsSync(baselinePath)) {
    console.error('Duplication baseline missing: .fallow-dupes-baseline.json');
    console.error('Regenerate with: pnpm exec fallow dupes --production --threshold 10 --save-baseline .fallow-dupes-baseline.json --summary');
    process.exit(1);
}

const raw = execFileSync('pnpm', [
    'exec',
    'fallow',
    'dupes',
    '--production',
    '--threshold',
    '10',
    '--baseline',
    baselinePath,
    '--format',
    'json',
], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
});

const report = JSON.parse(raw);
const newGroups = report.clone_groups ?? [];

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
console.error('Deduplicate the new clones, or if intentional refresh the baseline with: pnpm exec fallow dupes --production --threshold 10 --save-baseline .fallow-dupes-baseline.json --summary');
process.exit(1);
