import {
    mkdir,
    copyFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import esbuild from 'esbuild';

const { WORKER_BUNDLES } = await import(new URL('../packages/electron-worker-bundles/electronWorkerBundles.js', import.meta.url).href);

const emitSourceMaps = process.env.EVB_ELECTRON_SOURCEMAP === '1';
const buildGitSha = resolveBuildGitSha();
const buildGitShaDefine = {
    '__EVB_BUILD_GIT_SHA__': JSON.stringify(buildGitSha),
    'process.env.EVB_BUILD_GIT_SHA': JSON.stringify(buildGitSha ?? ''),
};
const initialBundleOptions = {
    sourcemap: emitSourceMaps ? 'external' : false,
    sourcesContent: false,
    legalComments: 'none',
    metafile: true,
    define: buildGitShaDefine,
};

function resolveBuildGitSha() {
    const gitOptions = {
        encoding: 'utf8',
        stdio: [
            'ignore',
            'pipe',
            'ignore',
        ],
    };
    let status;
    try {
        status = execFileSync('git', [
            'status',
            '--porcelain',
        ], gitOptions).trim();
    } catch {
        const ciSha = process.env.GITHUB_SHA?.trim().toLowerCase() ?? '';
        // Keep in sync with SCAN_CLEANUP_GIT_SHA_HEX_PATTERN in scan-cleanup-core/provenanceStamp.ts.
        return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(ciSha) ? ciSha : null;
    }
    if (status !== '') {
        return null;
    }
    try {
        const sha = execFileSync('git', [
            'rev-parse',
            '--verify',
            'HEAD',
        ], gitOptions).trim().toLowerCase();
        // Keep in sync with SCAN_CLEANUP_GIT_SHA_HEX_PATTERN in scan-cleanup-core/provenanceStamp.ts.
        return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sha) ? sha : null;
    } catch {
        return null;
    }
}
const builds = [
    {
        entryPoints: {main: 'electron/main.ts'},
        format: 'esm',
        splitting: true,
        outdir: 'dist-electron',
        entryNames: '[name]',
        chunkNames: 'main-chunk-[name]-[hash]',
        metafileOutput: 'dist-electron/main.meta.json',
        external: ['electron'],
        // esbuild's ESM output shims dynamic CJS require() with a throwing
        // helper unless a real require exists in scope; Electron main runs in
        // Node, so createRequire restores builtin requires for CJS deps.
        banner: {js: `import { createRequire as __evbCreateRequire } from 'node:module';
const require = __evbCreateRequire(import.meta.url);`},
        ...initialBundleOptions,
    },
    {
        entryPoints: ['electron/preload.ts'],
        format: 'cjs',
        outfile: 'dist-electron/preload.cjs',
        metafileOutput: 'dist-electron/preload.meta.json',
        external: ['electron'],
        ...initialBundleOptions,
    },
    ...WORKER_BUNDLES.map(bundle => ({
        entryPoints: [bundle.entryPoint],
        format: bundle.format,
        outfile: `dist-electron/${bundle.fileName}`,
        external: ['electron'],
        define: buildGitShaDefine,
    })),
];

await rm('dist-electron', {
    recursive: true,
    force: true,
});
await mkdir('dist-electron', { recursive: true });

await Promise.all(builds.map(async ({
    metafileOutput,
    ...build
}) => {
    const result = await esbuild.build({
        bundle: true,
        minify: true,
        keepNames: true,
        platform: 'node',
        ...build,
    });
    if (metafileOutput && result.metafile) {
        await writeFile(metafileOutput, `${JSON.stringify(result.metafile)}\n`);
    }
}));

await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', 'dist-electron/pdf.worker.mjs');
// Pin dist-electron/*.js to ESM semantics regardless of loader heuristics.
// worker_threads resolves module type from the nearest package.json; the
// asar-unpacked copy of this directory has no other package.json above it.
await writeFile('dist-electron/package.json', `${JSON.stringify({ type: 'module' }, null, 4)}\n`);
