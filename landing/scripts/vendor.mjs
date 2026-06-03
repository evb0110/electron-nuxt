import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
} from 'node:fs';
import {
    dirname,
    join,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const landingRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoPackages = join(landingRoot, '..', 'packages');

const manifest = [
    {
        src: join(repoPackages, 'contracts/release.ts'),
        dest: join(landingRoot, 'vendor/contracts/release.ts'),
    },
];

for (const pkg of ['i18n-core', 'release-selection']) {
    const sourceDir = join(repoPackages, pkg);
    for (const file of readdirSync(sourceDir)) {
        if (file.endsWith('.ts')) {
            manifest.push({
                src: join(sourceDir, file),
                dest: join(landingRoot, 'vendor', pkg, file),
            });
        }
    }
}

const check = process.argv.includes('--check');
const drifted = [];

function transformVendoredSource(source) {
    return source
        .replaceAll('@evb/i18n-core/', './')
        .replaceAll('@evb/releaseSelection/releaseSelection', './releaseSelection');
}

for (const { src, dest } of manifest) {
    const source = transformVendoredSource(readFileSync(src, 'utf8'));

    if (check) {
        if (!existsSync(dest) || readFileSync(dest, 'utf8') !== source) {
            drifted.push(dest);
        }
        continue;
    }

    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
}

if (check && drifted.length) {
    console.error('landing/vendor is out of sync with ../packages:');
    for (const file of drifted) {
        console.error(`  ${file}`);
    }
    console.error('Run `pnpm sync:vendor` from landing/ and commit the result.');
    process.exit(1);
}

console.log(check
    ? 'landing/vendor is in sync with ../packages'
    : `Synced ${manifest.length} files into landing/vendor`);
