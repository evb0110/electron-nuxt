import {
    mkdir,
    writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {PDFDocument} from 'pdf-lib';

const BASE_DPI = 100;
const WIDTH = 850;
const HEIGHT = 1_100;
const POINT_WIDTH = 612;
const POINT_HEIGHT = 792;
const PAPER_NOISE_SEED_BASE = 0x5eed_0000;

const pageSpecs = [
    {
        id: 'gray-72-black-small',
        sourceDpi: 100,
        bodyPointSize: 14,
        codec: 'png',
        paper: [
            72,
            72,
            72,
        ],
        ink: [
            0,
            0,
            0,
        ],
        kind: 'text',
    },
    {
        id: 'gray-112-black-300dpi',
        sourceDpi: 300,
        bodyPointSize: 14,
        codec: 'png',
        paper: [
            112,
            112,
            112,
        ],
        ink: [
            8,
            8,
            8,
        ],
        kind: 'text',
    },
    {
        id: 'gray-152-faint-small',
        sourceDpi: 100,
        bodyPointSize: 8,
        codec: 'jpeg',
        jpegQuality: 75,
        paper: [
            152,
            152,
            152,
        ],
        ink: [
            96,
            96,
            96,
        ],
        kind: 'faint',
    },
    {
        id: 'gray-192-black',
        sourceDpi: 200,
        bodyPointSize: 10,
        codec: 'jpeg',
        jpegQuality: 92,
        paper: [
            192,
            192,
            192,
        ],
        ink: [
            20,
            20,
            20,
        ],
        kind: 'text',
    },
    {
        id: 'gray-232-tiny',
        sourceDpi: 150,
        bodyPointSize: 6,
        codec: 'jpeg',
        jpegQuality: 75,
        paper: [
            232,
            232,
            232,
        ],
        ink: [
            45,
            45,
            45,
        ],
        kind: 'tiny',
    },
    {
        id: 'blue-paper-blue-ink',
        sourceDpi: 150,
        bodyPointSize: 9,
        codec: 'png',
        paper: [
            205,
            225,
            245,
        ],
        ink: [
            12,
            32,
            76,
        ],
        kind: 'text',
    },
    {
        id: 'cream-paper-brown-ink',
        sourceDpi: 200,
        bodyPointSize: 9,
        codec: 'jpeg',
        jpegQuality: 92,
        paper: [
            235,
            220,
            175,
        ],
        ink: [
            55,
            42,
            18,
        ],
        kind: 'text',
    },
    {
        id: 'pink-paper-red-ink',
        sourceDpi: 300,
        bodyPointSize: 10,
        codec: 'jpeg',
        jpegQuality: 75,
        paper: [
            225,
            205,
            215,
        ],
        ink: [
            65,
            22,
            38,
        ],
        kind: 'text',
    },
    {
        id: 'green-paper-green-ink',
        sourceDpi: 300,
        bodyPointSize: 12,
        codec: 'png',
        paper: [
            190,
            215,
            195,
        ],
        ink: [
            20,
            58,
            30,
        ],
        kind: 'text',
    },
    {
        id: 'gray-gradient-text',
        sourceDpi: 200,
        bodyPointSize: 10,
        codec: 'jpeg',
        jpegQuality: 92,
        paper: [
            188,
            188,
            188,
        ],
        ink: [
            18,
            18,
            18,
        ],
        kind: 'gradient',
    },
    {
        id: 'blue-paper-independent-red-seal',
        sourceDpi: 200,
        bodyPointSize: 10,
        codec: 'jpeg',
        jpegQuality: 75,
        paper: [
            205,
            225,
            245,
        ],
        ink: [
            22,
            35,
            55,
        ],
        kind: 'seal',
    },
    {
        id: 'cream-paper-color-photo',
        sourceDpi: 200,
        bodyPointSize: 10,
        codec: 'jpeg',
        jpegQuality: 92,
        paper: [
            235,
            220,
            175,
        ],
        ink: [
            35,
            30,
            22,
        ],
        kind: 'photo',
    },
    {
        id: 'true-color-plate',
        sourceDpi: 150,
        codec: 'png',
        paper: [
            225,
            225,
            218,
        ],
        ink: [
            25,
            25,
            25,
        ],
        kind: 'color',
    },
    {
        id: 'tonal-gray-illustration',
        sourceDpi: 150,
        codec: 'jpeg',
        jpegQuality: 92,
        paper: [
            210,
            210,
            210,
        ],
        ink: [
            30,
            30,
            30,
        ],
        kind: 'tonal',
    },
    {
        id: 'sparse-faint-tiny-text',
        sourceDpi: 100,
        bodyPointSize: 8,
        codec: 'jpeg',
        jpegQuality: 75,
        paper: [
            198,
            210,
            220,
        ],
        ink: [
            135,
            145,
            154,
        ],
        kind: 'sparse',
    },
    {
        id: 'gray-scanner-cloud-dark-text',
        sourceDpi: 150,
        bodyPointSize: 9,
        codec: 'jpeg',
        jpegQuality: 82,
        paper: [
            205,
            205,
            205,
        ],
        ink: [
            28,
            28,
            28,
        ],
        kind: 'cloud',
    },
    {
        id: 'gray-bleedthrough-dark-text',
        sourceDpi: 150,
        bodyPointSize: 9,
        codec: 'jpeg',
        jpegQuality: 82,
        paper: [
            188,
            188,
            188,
        ],
        ink: [
            24,
            24,
            24,
        ],
        kind: 'bleed',
    },
    {
        id: 'gray-bleedthrough-highdpi-legal-stencil',
        sourceDpi: 300,
        bodyPointSize: 40,
        codec: 'jpeg',
        jpegQuality: 88,
        paper: [
            188,
            188,
            188,
        ],
        ink: [
            24,
            24,
            24,
        ],
        kind: 'bleed',
    },
    {
        id: 'gray-full-page-map-with-bleed',
        sourceDpi: 150,
        codec: 'jpeg',
        jpegQuality: 86,
        paper: [
            184,
            184,
            184,
        ],
        ink: [
            24,
            24,
            24,
        ],
        kind: 'map-bleed',
    },
];

function clamp(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function rng(seed) {
    let value = seed >>> 0;
    return () => {
        value = (value * 1_664_525 + 1_013_904_223) >>> 0;
        return value / 0x1_0000_0000;
    };
}

function rgb([
    red,
    green,
    blue,
], alpha = 1) {
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function rasterDimensions(sourceDpi) {
    return {
        height: Math.round(POINT_HEIGHT / 72 * sourceDpi),
        width: Math.round(POINT_WIDTH / 72 * sourceDpi),
    };
}

function paintPaper(context, spec, pageIndex, width, height) {
    const random = rng(PAPER_NOISE_SEED_BASE + pageIndex);
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = (y * width + x) * 4;
            const horizontal = spec.kind === 'gradient'
                ? (x / (width - 1) - 0.5) * 34
                : (x / (width - 1) - 0.5) * 6;
            const vertical = (y / (height - 1) - 0.5) * 4;
            const noise = (random() - 0.5) * (spec.kind === 'gradient' ? 7 : 4);
            const cloud = spec.kind === 'cloud'
                ? (
                    -38 * Math.exp(
                        -(
                            ((x / width - 0.26) / 0.24) ** 2
                            + ((y / height - 0.33) / 0.20) ** 2
                        ),
                    )
                    - 24 * Math.exp(
                        -(
                            ((x / width - 0.73) / 0.30) ** 2
                            + ((y / height - 0.70) / 0.24) ** 2
                        ),
                    )
                    + 9 * Math.sin(x / width * Math.PI * 1.6)
                )
                : 0;
            for (let channel = 0; channel < 3; channel += 1) {
                image.data[offset + channel] = clamp(
                    spec.paper[channel] + horizontal + vertical + noise + cloud,
                );
            }
            image.data[offset + 3] = 255;
        }
    }
    context.putImageData(image, 0, 0);
}

function drawTextPage(context, spec, pageIndex) {
    context.fillStyle = rgb(spec.ink);
    context.textBaseline = 'top';
    context.font = `bold ${20 * BASE_DPI / 72}px Georgia`;
    context.fillText(`SYNTHETIC ${String(pageIndex + 1).padStart(2, '0')} · ${spec.id}`, 55, 45);
    const bodyPixels = spec.bodyPointSize * BASE_DPI / 72;
    context.font = `${bodyPixels}px Georgia`;
    const lineHeight = Math.max(12, bodyPixels * 1.55);
    const lines = Math.min(50, Math.floor((970 - 105) / lineHeight));
    for (let line = 0; line < lines; line += 1) {
        const y = 105 + line * lineHeight;
        const column = line % 2;
        const x = 55 + column * 390;
        context.fillText(
            `${String(line + 1).padStart(2, '0')} dark text must survive on uniform paper`,
            x,
            y,
            355,
        );
    }
    drawCalibrationComb(context, spec.ink);
}

function drawCalibrationComb(context, ink) {
    context.fillStyle = rgb(ink);
    const barWidths = [
        0.5,
        0.75,
        1,
        1.5,
        2,
        3,
        4,
    ];
    let x = 365;
    for (const width of barWidths) {
        context.fillRect(x, 72, width, 25);
        x += 14;
    }
    context.strokeStyle = rgb(ink);
    let centerX = 620;
    for (const lineWidth of [
        0.75,
        1,
        1.5,
        2,
        3,
        4,
    ]) {
        context.lineWidth = lineWidth;
        context.beginPath();
        context.arc(centerX, 84, 8, 0, Math.PI * 2);
        context.stroke();
        centerX += 28;
    }
}

function drawSeal(context) {
    context.strokeStyle = 'rgb(172, 28, 42)';
    context.lineWidth = 9;
    context.beginPath();
    context.arc(690, 850, 70, 0, Math.PI * 2);
    context.stroke();
    context.font = 'bold 21px Arial';
    context.fillStyle = 'rgb(172, 28, 42)';
    context.fillText('INDEPENDENT RED', 605, 835);
}

function drawPhoto(context) {
    const gradient = context.createLinearGradient(470, 620, 790, 940);
    gradient.addColorStop(0, 'rgb(25, 78, 165)');
    gradient.addColorStop(0.35, 'rgb(60, 175, 125)');
    gradient.addColorStop(0.7, 'rgb(232, 175, 48)');
    gradient.addColorStop(1, 'rgb(150, 35, 68)');
    context.fillStyle = gradient;
    context.fillRect(470, 620, 320, 320);
    const random = rng(0x51de_cafe);
    const raster = context.getImageData(470, 620, 320, 320);
    for (let offset = 0; offset < raster.data.length; offset += 4) {
        const texture = (random() - 0.5) * 34;
        raster.data[offset] = clamp(raster.data[offset] + texture);
        raster.data[offset + 1] = clamp(raster.data[offset + 1] + texture);
        raster.data[offset + 2] = clamp(raster.data[offset + 2] + texture);
    }
    context.putImageData(raster, 470, 620);
    context.fillStyle = 'rgba(255, 255, 255, 0.8)';
    for (let index = 0; index < 12; index += 1) {
        context.beginPath();
        context.arc(495 + (index % 4) * 82, 650 + Math.floor(index / 4) * 105, 25, 0, Math.PI * 2);
        context.fill();
    }
}

function drawColorPlate(context) {
    const colors = [
        'rgb(190, 35, 55)',
        'rgb(35, 100, 205)',
        'rgb(35, 155, 80)',
        'rgb(225, 150, 30)',
        'rgb(110, 45, 165)',
        'rgb(30, 160, 170)',
    ];
    for (let row = 0; row < 5; row += 1) {
        for (let column = 0; column < 4; column += 1) {
            context.fillStyle = colors[(row + column) % colors.length];
            context.fillRect(75 + column * 175, 160 + row * 165, 140, 130);
        }
    }
    drawColorPlateLabel(context, [
        25,
        25,
        25,
    ]);
}

function drawColorPlateLabel(context, color) {
    context.fillStyle = rgb(color);
    context.font = 'bold 28px Arial';
    context.fillText('TRUE COLOR PLATE — PRESERVE CHROMA', 85, 1_015);
}

function drawTonalIllustration(context) {
    const gradient = context.createRadialGradient(425, 540, 20, 425, 540, 360);
    gradient.addColorStop(0, 'rgb(35, 35, 35)');
    gradient.addColorStop(0.35, 'rgb(100, 100, 100)');
    gradient.addColorStop(0.7, 'rgb(175, 175, 175)');
    gradient.addColorStop(1, 'rgb(225, 225, 225)');
    context.fillStyle = gradient;
    context.fillRect(85, 190, 680, 700);
    context.strokeStyle = 'rgb(20, 20, 20)';
    context.lineWidth = 4;
    for (let radius = 70; radius <= 300; radius += 38) {
        context.beginPath();
        context.arc(425, 540, radius, 0, Math.PI * 2);
        context.stroke();
    }
}

function drawSparse(context, spec) {
    context.fillStyle = rgb(spec.ink);
    context.textBaseline = 'top';
    context.font = `${spec.bodyPointSize * BASE_DPI / 72}px Georgia`;
    for (let line = 0; line < 5; line += 1) {
        context.fillText(
            `tiny faint line ${line + 1}: these strokes must not disappear`,
            285,
            420 + line * 24,
        );
    }
}

function drawBleedThrough(context) {
    context.save();
    context.translate(WIDTH, 0);
    context.scale(-1, 1);
    context.fillStyle = 'rgba(55, 55, 55, 0.16)';
    context.font = '18px Georgia';
    context.textBaseline = 'top';
    for (let line = 0; line < 34; line += 1) {
        const x = 90 + (line % 3) * 18;
        const y = 72 + line * 29;
        context.fillText(
            `reverse-side print ${String(line + 1).padStart(2, '0')} must clean as paper`,
            x,
            y,
            640,
        );
    }
    context.restore();
}

function drawMap(context, mask = false) {
    const lineColor = mask ? 'black' : 'rgb(28, 28, 28)';
    context.save();
    context.strokeStyle = lineColor;
    context.fillStyle = lineColor;
    context.lineWidth = 2;
    context.font = 'bold 24px Georgia';
    context.fillText('SYNTHETIC MAP — WHITE PAPER, RETAINED TONE', 58, 42);
    context.strokeRect(48, 92, 754, 940);
    for (let row = 0; row < 13; row += 1) {
        context.beginPath();
        for (let x = 62; x <= 786; x += 10) {
            const y = 125 + row * 67
                + Math.sin(x * 0.024 + row * 0.7) * (13 + row % 3 * 4);
            if (x === 62) context.moveTo(x, y);
            else context.lineTo(x, y);
        }
        context.stroke();
    }
    for (let column = 0; column < 10; column += 1) {
        context.beginPath();
        for (let y = 110; y <= 1_010; y += 10) {
            const x = 88 + column * 72
                + Math.cos(y * 0.021 + column * 0.9) * (10 + column % 4 * 3);
            if (y === 110) context.moveTo(x, y);
            else context.lineTo(x, y);
        }
        context.stroke();
    }
    if (!mask) {
        context.fillStyle = 'rgb(139, 139, 139)';
        context.beginPath();
        context.ellipse(270, 410, 115, 165, 0.35, 0, Math.PI * 2);
        context.fill();
        context.fillStyle = 'rgb(92, 92, 92)';
        context.beginPath();
        context.ellipse(590, 710, 92, 138, -0.45, 0, Math.PI * 2);
        context.fill();
    }
    context.strokeStyle = lineColor;
    context.lineWidth = 4;
    for (let index = 0; index < 7; index += 1) {
        context.beginPath();
        context.arc(420, 540, 75 + index * 34, 0.15, Math.PI * 1.6);
        context.stroke();
    }
    context.fillStyle = lineColor;
    context.font = '18px Georgia';
    for (let index = 0; index < 24; index += 1) {
        context.fillText(
            `M${String(index + 1).padStart(2, '0')}`,
            82 + index % 6 * 120,
            160 + Math.floor(index / 6) * 260,
        );
    }
    context.restore();
}

function drawPageContent(context, spec, pageIndex) {
    if (spec.kind === 'color') {
        drawColorPlate(context);
    } else if (spec.kind === 'tonal') {
        drawTonalIllustration(context);
    } else if (spec.kind === 'sparse') {
        drawSparse(context, spec);
    } else if (spec.kind === 'map-bleed') {
        drawBleedThrough(context);
        drawMap(context);
    } else {
        if (spec.kind === 'bleed') drawBleedThrough(context);
        drawTextPage(context, spec, pageIndex);
        if (spec.kind === 'seal') drawSeal(context);
        if (spec.kind === 'photo') drawPhoto(context);
    }
}

function drawInkMaskContent(context, spec, pageIndex) {
    const maskSpec = {
        ...spec,
        ink: [
            0,
            0,
            0,
        ],
    };
    if (spec.kind === 'sparse') {
        drawSparse(context, maskSpec);
    } else if (spec.kind === 'color') {
        drawColorPlateLabel(context, maskSpec.ink);
    } else if (spec.kind === 'map-bleed') {
        drawMap(context, true);
    } else if ([
        'text',
        'faint',
        'tiny',
        'gradient',
        'cloud',
        'seal',
        'photo',
        'bleed',
    ].includes(spec.kind)) {
        drawTextPage(context, maskSpec, pageIndex);
    }
}

function renderPage(spec, pageIndex) {
    const {
        width,
        height,
    } = rasterDimensions(spec.sourceDpi);
    const scale = spec.sourceDpi / BASE_DPI;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    paintPaper(context, spec, pageIndex, width, height);
    context.save();
    context.scale(scale, scale);
    drawPageContent(context, spec, pageIndex);
    context.restore();

    const maskCanvas = createCanvas(width, height);
    const maskContext = maskCanvas.getContext('2d');
    maskContext.fillStyle = 'white';
    maskContext.fillRect(0, 0, width, height);
    maskContext.save();
    maskContext.scale(scale, scale);
    drawInkMaskContent(maskContext, spec, pageIndex);
    maskContext.restore();

    const image = spec.codec === 'png'
        ? canvas.toBuffer('image/png')
        : canvas.toBuffer('image/jpeg', spec.jpegQuality);
    return {
        height,
        image,
        imageType: spec.codec,
        inkMask: maskCanvas.toBuffer('image/png'),
        width,
    };
}

function groundTruthFor(spec, inkMaskPath) {
    const regions = {
        independentColor: [],
        ink: [],
        protectedTone: [],
    };
    if ([
        'text',
        'faint',
        'tiny',
        'gradient',
        'cloud',
        'seal',
        'photo',
        'bleed',
    ].includes(spec.kind)) {
        regions.ink.push({
            croppable: false,
            height: 990,
            width: 750,
            x: 50,
            y: 40,
        });
    } else if (spec.kind === 'map-bleed') {
        regions.ink.push({
            croppable: false,
            height: 1_010,
            width: 770,
            x: 40,
            y: 35,
        });
        regions.protectedTone.push(
            {
                height: 330,
                rotationRadians: 0.35,
                shape: 'ellipse',
                width: 230,
                x: 155,
                y: 245,
            },
            {
                height: 276,
                rotationRadians: -0.45,
                shape: 'ellipse',
                width: 184,
                x: 498,
                y: 572,
            },
        );
    } else if (spec.kind === 'sparse') {
        regions.ink.push({
            croppable: false,
            height: 132,
            width: 360,
            x: 275,
            y: 410,
        });
    } else if (spec.kind === 'color') {
        regions.ink.push({
            croppable: false,
            height: 55,
            width: 700,
            x: 75,
            y: 995,
        });
    }
    if (spec.kind === 'seal') {
        regions.independentColor.push({
            height: 170,
            shape: 'ellipse',
            width: 190,
            x: 595,
            y: 765,
        });
    } else if (spec.kind === 'photo') {
        regions.independentColor.push({
            height: 320,
            width: 320,
            x: 470,
            y: 620,
        });
        regions.protectedTone.push({
            height: 320,
            width: 320,
            x: 470,
            y: 620,
        });
    } else if (spec.kind === 'color') {
        regions.independentColor.push({
            height: 790,
            width: 665,
            x: 75,
            y: 160,
        });
    } else if (spec.kind === 'tonal') {
        // The protected region is the unambiguously continuous-tone core.
        // The pale outer field intentionally remains paper-like so cleanup is
        // allowed to whiten it without the audit counting that as lost art.
        regions.protectedTone.push({
            height: 700,
            width: 680,
            x: 85,
            y: 190,
        });
    }
    return {
        calibrationProbes: ![
            'text',
            'faint',
            'tiny',
            'gradient',
            'cloud',
            'seal',
            'photo',
            'bleed',
        ].includes(spec.kind)
            ? []
            : [
                ...[
                    0.5,
                    0.75,
                    1,
                    1.5,
                    2,
                    3,
                    4,
                ].map((width, index) => ({
                    croppable: false,
                    height: 25,
                    type: 'bar',
                    width,
                    x: 365 + index * 14,
                    y: 72,
                })),
                ...[
                    0.75,
                    1,
                    1.5,
                    2,
                    3,
                    4,
                ].map((lineWidth, index) => ({
                    centerX: 620 + index * 28,
                    centerY: 84,
                    croppable: false,
                    lineWidth,
                    radius: 8,
                    type: 'ring',
                })),
            ],
        inkMaskPath,
        paperCanvas: {
            height: HEIGHT,
            width: WIDTH,
            x: 0,
            y: 0,
        },
        regions,
    };
}

async function main() {
    const outputArg = process.argv[2];
    if (!outputArg) {
        throw new Error(
            'Usage: node scripts/diagnostics/generate-scan-cleanup-smoke-fixture.mjs <output.pdf>',
        );
    }
    const outputPath = path.resolve(outputArg);
    await mkdir(path.dirname(outputPath), {recursive: true});
    const groundTruthDirectory = `${outputPath}.ground-truth`;
    await mkdir(groundTruthDirectory, {recursive: true});
    const document = await PDFDocument.create();
    const renderedPages = [];
    for (const [
        pageIndex,
        spec,
    ] of pageSpecs.entries()) {
        const rendered = renderPage(spec, pageIndex);
        renderedPages.push(rendered);
        const image = rendered.imageType === 'png'
            ? await document.embedPng(rendered.image)
            : await document.embedJpg(rendered.image);
        const page = document.addPage([
            POINT_WIDTH,
            POINT_HEIGHT,
        ]);
        page.drawImage(image, {
            height: POINT_HEIGHT,
            width: POINT_WIDTH,
            x: 0,
            y: 0,
        });
        await writeFile(
            path.join(
                groundTruthDirectory,
                `page-${String(pageIndex + 1).padStart(2, '0')}-ink-alpha.png`,
            ),
            rendered.inkMask,
        );
    }
    await writeFile(outputPath, await document.save({useObjectStreams: false}));
    await writeFile(
        `${outputPath}.json`,
        `${JSON.stringify({
            height: HEIGHT,
            pageCount: pageSpecs.length,
            randomSeedBase: PAPER_NOISE_SEED_BASE,
            pages: pageSpecs.map((spec, pageIndex) => ({
                ...spec,
                groundTruth: groundTruthFor(
                    spec,
                    path.join(
                        groundTruthDirectory,
                        `page-${String(pageIndex + 1).padStart(2, '0')}-ink-alpha.png`,
                    ),
                ),
                rasterHeight: renderedPages[pageIndex].height,
                rasterWidth: renderedPages[pageIndex].width,
            })),
            width: WIDTH,
        }, null, 2)}\n`,
    );
    console.log(`Wrote ${pageSpecs.length}-page scan-cleanup smoke fixture: ${outputPath}`);
}

await main();
