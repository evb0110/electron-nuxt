import {execFile} from 'node:child_process';
import {
    access,
    mkdir,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {createCanvas} from '@napi-rs/canvas';

const run = promisify(execFile);
const PAGE_POINTS = {
    height: 792,
    width: 612,
};
const BACKGROUND_DPI = 120;
const FOREGROUND_DPI = 360;
const specs = [
    {
        id: 'gray-72-ghost-only',
        paper: [
            72,
            72,
            72,
        ],
        tone: false,
        toneNearText: false,
    },
    {
        id: 'gray-152-ghost-and-fill',
        paper: [
            152,
            152,
            152,
        ],
        tone: true,
        toneNearText: false,
    },
    {
        id: 'gray-232-ghost-and-near-fill',
        paper: [
            232,
            232,
            232,
        ],
        tone: true,
        toneNearText: true,
    },
    {
        id: 'blue-tint-ghost-and-fill',
        paper: [
            205,
            225,
            245,
        ],
        tone: true,
        toneNearText: false,
    },
];

function dimensions(dpi) {
    return {
        height: Math.round(PAGE_POINTS.height / 72 * dpi),
        width: Math.round(PAGE_POINTS.width / 72 * dpi),
    };
}

function clamp(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function color(channels, alpha = 1) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`;
}

function drawText(context, scale, fillStyle) {
    context.save();
    context.scale(scale, scale);
    context.fillStyle = fillStyle;
    context.textBaseline = 'top';
    context.font = 'bold 16px Georgia';
    context.fillText('AUTHORED MRC OWNERSHIP', 48, 42);
    context.font = '8px Georgia';
    for (let row = 0; row < 31; row += 1) {
        const x = row % 2 === 0 ? 52 : 320;
        const y = 92 + row * 19;
        context.fillText(
            `${String(row + 1).padStart(2, '0')} small dark text must survive`,
            x,
            y,
        );
    }
    context.font = '6px Georgia';
    context.fillText('tiny footer 0O1Il — retained as selected foreground', 170, 748);
    context.restore();
}

function drawBlurredGhost(context, scale, paper) {
    const ghost = paper.map(channel => clamp(channel - 44));
    const offsets = [
        [
            -2,
            -1,
            0.035,
        ],
        [
            -1,
            0,
            0.055,
        ],
        [
            0,
            0,
            0.09,
        ],
        [
            1,
            0,
            0.055,
        ],
        [
            2,
            1,
            0.035,
        ],
        [
            0,
            2,
            0.03,
        ],
    ];
    for (const [
        x,
        y,
        alpha,
    ] of offsets) {
        context.save();
        context.translate(x, y);
        drawText(context, scale, color(ghost, alpha));
        context.restore();
    }
}

function drawTone(context, scale, spec) {
    if (!spec.tone) {
        return;
    }
    context.save();
    context.scale(scale, scale);
    const x = spec.toneNearText ? 248 : 390;
    const y = spec.toneNearText ? 300 : 520;
    const gradient = context.createLinearGradient(x, y, x + 145, y + 135);
    gradient.addColorStop(0, color(spec.paper.map(channel => clamp(channel - 86))));
    gradient.addColorStop(1, color(spec.paper.map(channel => clamp(channel - 28))));
    context.fillStyle = gradient;
    context.beginPath();
    context.ellipse(x + 72, y + 68, 72, 68, 0.22, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = color(spec.paper.map(channel => clamp(channel - 105)));
    context.lineWidth = 2;
    for (let index = 0; index < 7; index += 1) {
        context.beginPath();
        context.arc(x + 72, y + 68, 18 + index * 7, 0.2, Math.PI * 1.75);
        context.stroke();
    }
    context.restore();
}

function renderBackground(spec) {
    const {
        height,
        width,
    } = dimensions(BACKGROUND_DPI);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = color(spec.paper);
    context.fillRect(0, 0, width, height);
    const scale = BACKGROUND_DPI / 72;
    drawBlurredGhost(context, scale, spec.paper);
    drawTone(context, scale, spec);
    return canvas.toBuffer('image/png');
}

function renderForeground() {
    const {
        height,
        width,
    } = dimensions(FOREGROUND_DPI);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    drawText(context, FOREGROUND_DPI / 72, 'black');
    return canvas.toBuffer('image/png');
}

function renderSelection() {
    const {
        height,
        width,
    } = dimensions(FOREGROUND_DPI);
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    drawText(context, FOREGROUND_DPI / 72, 'black');
    return canvas.toBuffer('image/png');
}

async function firstExecutable(candidates) {
    for (const candidate of candidates) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Continue to the next deterministic local build location.
        }
    }
    throw new Error(`Missing native PDF image combiner. Tried: ${candidates.join(', ')}`);
}

async function main() {
    const outputArgument = process.argv[2];
    if (!outputArgument) {
        throw new Error(
            'Usage: node scripts/diagnostics/generate-scan-cleanup-mrc-ownership-fixture.mjs <output.pdf>',
        );
    }
    const outputPath = path.resolve(outputArgument);
    const assetDirectory = `${outputPath}.assets`;
    await mkdir(path.dirname(outputPath), {recursive: true});
    await mkdir(assetDirectory, {recursive: true});
    const manifestRows = [];
    for (const [
        index,
        spec,
    ] of specs.entries()) {
        const prefix = path.join(
            assetDirectory,
            `page-${String(index + 1).padStart(2, '0')}`,
        );
        const backgroundPath = `${prefix}-background.png`;
        const backgroundRgbaPath = `${prefix}-background-rgba.png`;
        const foregroundPngPath = `${prefix}-foreground.png`;
        const foregroundGrayPath = `${prefix}-foreground-gray.png`;
        const foregroundJp2Path = `${prefix}-foreground.jp2`;
        const selectionPngPath = `${prefix}-selection.png`;
        const selectionPbmPath = `${prefix}-selection.pbm`;
        await Promise.all([
            writeFile(backgroundRgbaPath, renderBackground(spec)),
            writeFile(foregroundPngPath, renderForeground()),
            writeFile(selectionPngPath, renderSelection()),
        ]);
        await Promise.all([
            run('magick', [
                backgroundRgbaPath,
                '-alpha',
                'off',
                `PNG24:${backgroundPath}`,
            ]),
            run('magick', [
                foregroundPngPath,
                '-alpha',
                'off',
                '-colorspace',
                'Gray',
                `PNG8:${foregroundGrayPath}`,
            ]),
            run('magick', [
                selectionPngPath,
                '-threshold',
                '50%',
                selectionPbmPath,
            ]),
        ]);
        await run('sips', [
            '-s',
            'format',
            'jp2',
            foregroundGrayPath,
            '--out',
            foregroundJp2Path,
        ]);
        manifestRows.push([
            'affine-masked-layered-jpeg',
            PAGE_POINTS.width,
            PAGE_POINTS.height,
            87,
            backgroundPath,
            foregroundJp2Path,
            selectionPbmPath,
            PAGE_POINTS.width,
            0,
            0,
            PAGE_POINTS.height,
            0,
            0,
        ].join('\t'));
    }
    const manifestPath = path.join(assetDirectory, 'combine-manifest.tsv');
    await writeFile(manifestPath, `${manifestRows.join('\n')}\n`);
    const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
    const combiner = await firstExecutable([
        path.join(repositoryRoot, '.tmp/pdf-image-combine/darwin-arm64/bin/evb-pdf-image-combine'),
        path.join(repositoryRoot, 'native/target/release/evb-pdf-image-combine'),
    ]);
    await run(combiner, [
        '--compact-manifest',
        manifestPath,
        '--output',
        outputPath,
    ], {maxBuffer: 16 * 1024 * 1024});
    await writeFile(`${outputPath}.json`, `${JSON.stringify({
        backgroundDpi: BACKGROUND_DPI,
        foregroundDpi: FOREGROUND_DPI,
        pageCount: specs.length,
        pages: specs,
    }, null, 2)}\n`);
    console.log(`Wrote ${specs.length}-page authored-layer MRC fixture: ${outputPath}`);
}

await main();
