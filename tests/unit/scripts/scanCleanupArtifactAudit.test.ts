import {spawnSync} from 'node:child_process';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
        force: true,
        recursive: true,
    })));
});

describe('scan cleanup artifact acceptance', () => {
    it('fails gray Mixed paper, destroyed color, and missing metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-audit-test-'));
        temporaryDirectories.push(directory);
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, pathlib, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
gray = module.metrics(Image.new("RGB", (200, 200), (180, 180, 180)))
candidate, gray_failures = module.page_acceptance_failures(
    "mixed", "text-with-pictures", gray, gray, None, {"significantPicture": True}
)
photo = Image.new("RGB", (200, 200), "white")
for y in range(160):
    for x in range(200):
        value = 40 + (x + y) % 120
        photo.putpixel((x, y), (value, value, value))
photo_metrics = module.metrics(photo)
_, photo_failures = module.page_acceptance_failures(
    "mixed", "text-with-pictures", photo_metrics, photo_metrics, None,
    {"significantPicture": True}
)
spatial_candidate, spatial_failures = module.page_acceptance_failures(
    "grayscale", "spatial-tone", gray, gray, None, {}
)
tonal_candidate, tonal_failures = module.page_acceptance_failures(
    "grayscale", "uncertain-fallback", gray, gray, None,
    {"coherentOutsideTonalRegion": True, "destructiveModeTonalVeto": True}
)
red = module.metrics(Image.new("RGB", (200, 200), (220, 40, 35)))
neutral = module.metrics(Image.new("RGB", (200, 200), (220, 220, 220)))
_, color_failures = module.page_acceptance_failures(
    "color", "significant-color", red, neutral, None, {"significantColor": True}
)
try:
    module.load_metadata(pathlib.Path(sys.argv[2]), 1, 0)
    missing_metadata = False
except RuntimeError:
    missing_metadata = True
print(json.dumps({
    "candidate": candidate,
    "grayFailures": gray_failures,
    "photoFailures": photo_failures,
    "spatialCandidate": spatial_candidate,
    "spatialFailures": spatial_failures,
    "tonalCandidate": tonal_candidate,
    "tonalFailures": tonal_failures,
    "colorFailures": color_failures,
    "missingMetadata": missing_metadata,
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
            directory,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            candidate: false,
            grayFailures: [
                'mixed-paper-p90=180<248',
                'protected-tone-levels=1<4',
            ],
            photoFailures: [],
            spatialCandidate: true,
            spatialFailures: ['paper-p75=180<248'],
            tonalCandidate: false,
            tonalFailures: ['protected-tone-levels=1<4'],
            colorFailures: [
                'independent-color-chroma-p99=0<92.5',
                'full-bleed-color-p50=220>141',
            ],
            missingMetadata: true,
        });
    });

    it('loads split-output metadata and measures only its source region', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-audit-split-test-'));
        temporaryDirectories.push(directory);
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, pathlib, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
directory = pathlib.Path(sys.argv[2])
(directory / "analysis-4.json").write_text(json.dumps({
    "recommendedOutputMode": "bw",
    "outputModeDiagnostics": {"rule": "dense-text"},
}))
(directory / "clean-4-1.json").write_text(json.dumps({
    "half": "right",
    "inputWidthPx": 400,
    "inputHeightPx": 200,
    "sourceRegion": {"xPx": 200, "yPx": 0, "widthPx": 200, "heightPx": 200},
    "contentBox": {"xPx": 10, "yPx": 10, "widthPx": 180, "heightPx": 180},
}))
mode, rule, crop, diagnostics, output = module.load_metadata(directory, 4, 1)
image = Image.new("RGB", (400, 200), "black")
for y in range(200):
    for x in range(200, 400):
        image.putpixel((x, y), (240, 240, 240))
region = module.source_region_image(image, output)
print(json.dumps({
    "mode": mode,
    "rule": rule,
    "size": region.size,
    "p50": module.metrics(region).p50,
    "cropLeft": crop.left_fraction,
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
            directory,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            mode: 'bw',
            rule: 'dense-text',
            size: [
                200,
                200,
            ],
            p50: 240,
            cropLeft: 0.05,
        });
    });

    it('finds source-derived continuous tone without mistaking uniform text paper for a photo', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-audit-tone-test-'));
        temporaryDirectories.push(directory);
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

text_source = Image.new("RGB", (400, 300), (180, 180, 180))
text_draw = ImageDraw.Draw(text_source)
for row in range(14):
    top = 18 + row * 18
    text_draw.rectangle((24, top, 330, top + 3), fill=(30, 30, 30))
text_output = Image.new("RGB", text_source.size, "white")
text_output.paste(text_source, mask=Image.new("L", text_source.size, 0))
text_tone = module.continuous_tone_metrics(text_source, text_output, 100)

photo_source = text_source.copy()
for y in range(70, 230):
    for x in range(110, 330):
        value = 28 + ((x * 7 + y * 11) % 188)
        photo_source.putpixel((x, y), (value, value, value))
preserved = photo_source.copy()
damaged = Image.new("RGB", photo_source.size, "white")
for y in range(70, 230):
    for x in range(110, 330):
        value = photo_source.getpixel((x, y))[0]
        lifted = min(255, value + 88)
        damaged.putpixel((x, y), (lifted, lifted, lifted))
preserved_tone = module.continuous_tone_metrics(photo_source, preserved, 100)
damaged_tone = module.continuous_tone_metrics(photo_source, damaged, 100)
source_metrics = module.metrics(photo_source)
damaged_metrics = module.metrics(damaged)
_, failures = module.page_acceptance_failures(
    "grayscale", "bilevel-fidelity", source_metrics, damaged_metrics, None,
    {"significantPicture": True}, damaged_tone
)
dense_text_tone = module.ToneMetrics(
    coverage_fraction=0.03,
    component_count=2,
    source_p10=80,
    source_p50=170,
    source_p90=255,
    output_p10=132,
    output_p50=254,
    output_p90=255,
    p10_lift=52,
    p50_lift=84,
    range_ratio=0.70,
    output_endpoint_fraction=0.20,
)
_, dense_text_failures = module.page_acceptance_failures(
    "grayscale", "bilevel-fidelity", source_metrics, damaged_metrics, None,
    {"destructiveModeTonalVeto": True}, dense_text_tone
)
line_art_tone = module.ToneMetrics(
    coverage_fraction=0.05,
    component_count=3,
    source_p10=70,
    source_p50=165,
    source_p90=190,
    output_p10=96,
    output_p50=210,
    output_p90=238,
    p10_lift=26,
    p50_lift=45,
    range_ratio=1.18,
    output_endpoint_fraction=0.0,
)
_, line_art_failures = module.page_acceptance_failures(
    "grayscale", "uncertain-fallback", source_metrics, damaged_metrics, None,
    {"coherentOutsideTonalRegion": True}, line_art_tone
)
print(json.dumps({
    "textTone": text_tone,
    "preservedLift10": preserved_tone.p10_lift,
    "preservedLift50": preserved_tone.p50_lift,
    "damagedCoverage": damaged_tone.coverage_fraction,
    "damagedLift10": damaged_tone.p10_lift,
    "damagedLift50": damaged_tone.p50_lift,
    "failures": failures,
    "denseTextFailures": dense_text_failures,
    "lineArtFailures": line_art_failures,
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
            directory,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.textTone).toBeNull();
        expect(report.preservedLift10).toBe(0);
        expect(report.preservedLift50).toBe(0);
        expect(report.damagedCoverage).toBeGreaterThan(0.10);
        expect(report.damagedLift10).toBeGreaterThan(24);
        expect(report.damagedLift50).toBeGreaterThan(32);
        expect(report.failures).toHaveLength(1);
        expect(report.failures[0]).toContain(
            `continuous-tone-damage:p10+${report.damagedLift10}>24,p50+${report.damagedLift50}>32`,
        );
        expect(report.denseTextFailures).toEqual([]);
        expect(report.lineArtFailures).toEqual([]);
    });

    it('rejects cleanup-only block seams while accepting source layout edges', () => {
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

source = Image.new("RGB", (320, 240), (180, 180, 180))
draw = ImageDraw.Draw(source)
draw.rectangle((150, 0, 154, 239), fill=(30, 30, 30))
preserved = source.copy()
blocked = source.copy()
blocked_draw = ImageDraw.Draw(blocked)
blocked_draw.rectangle((40, 30, 99, 209), fill=(225, 225, 225))
photo_source = Image.new("RGB", (320, 240), (180, 180, 180))
photo_blocked = photo_source.copy()
ImageDraw.Draw(photo_blocked).rectangle((0, 120, 319, 239), fill=(225, 225, 225))
preserved_seams = module.block_seam_metrics(source, preserved, 100)
blocked_seams = module.block_seam_metrics(source, blocked, 100)
photo_seams = module.block_seam_metrics(photo_source, photo_blocked, 100)
metrics = module.metrics(source)
damaged_photo_tone = module.ToneMetrics(
    0.5, 1, 80, 120, 180, 120, 180, 255, 40, 60, 0.60, 0.20
)
_, failures = module.page_acceptance_failures(
    "grayscale", "bilevel-fidelity", metrics, module.metrics(blocked), None,
    {}, None, blocked_seams
)
_, photo_failures = module.page_acceptance_failures(
    "grayscale", "text-with-pictures", module.metrics(photo_source),
    module.metrics(photo_blocked), None,
    {
        "significantPicture": True,
        "pictureFraction": 0.45,
        "midtoneFraction": 0.20,
        "bimodality": 0.55,
    }, damaged_photo_tone, photo_seams
)
_, line_art_failures = module.page_acceptance_failures(
    "grayscale", "text-with-pictures", module.metrics(photo_source),
    module.metrics(photo_blocked), None,
    {
        "significantPicture": True,
        "coherentOutsideTonalRegion": True,
        "pictureFraction": 0.75,
        "midtoneFraction": 0.12,
        "bimodality": 0.80,
    }, None, photo_seams
)
print(json.dumps({
    "preserved": preserved_seams.count,
    "blocked": blocked_seams.count,
    "longest": blocked_seams.longest_run_px,
    "jump": blocked_seams.maximum_jump,
    "photoDominantSingle": photo_seams.dominant_single,
    "failures": failures,
    "photoFailures": photo_failures,
    "lineArtFailures": line_art_failures,
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.preserved).toBe(0);
        expect(report.blocked).toBeGreaterThan(0);
        expect(report.longest).toBeGreaterThanOrEqual(180);
        expect(report.jump).toBe(45);
        expect(report.photoDominantSingle).toBe(true);
        expect(report.failures.some((failure: string) => failure.startsWith('block-seams='))).toBe(true);
        expect(report.photoFailures.some((failure: string) => failure.startsWith('block-seams='))).toBe(true);
        expect(report.lineArtFailures.some((failure: string) => failure.startsWith('block-seams='))).toBe(false);
    });

    it('rejects fragmented whitening boundaries even when they do not form rectangles', () => {
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

source = Image.new("RGB", (360, 280), (178, 178, 178))
source_draw = ImageDraw.Draw(source)
source_draw.rectangle((20, 18, 340, 22), fill=(24, 24, 24))
source_draw.ellipse((90, 75, 260, 220), fill=(118, 118, 118))
source_draw.ellipse((118, 98, 232, 198), fill=(96, 96, 96))
source_draw.ellipse((145, 122, 205, 178), fill=(72, 72, 72))
output = source.copy()
output_draw = ImageDraw.Draw(output)
for box in [
    (28, 45, 82, 120),
    (275, 55, 332, 145),
    (35, 180, 110, 252),
    (245, 182, 330, 250),
]:
    output_draw.ellipse(box, fill="white")

fidelity = module.source_fidelity_metrics(source, output)
source_metrics = module.metrics(source)
_, failures = module.page_acceptance_failures(
    "mixed", "text-with-pictures", source_metrics, module.metrics(output),
    None, {"significantPicture": True}, None, None, None, fidelity, False, True
)
identity = module.source_fidelity_metrics(source, source.copy())
_, identity_failures = module.page_acceptance_failures(
    "mixed", "text-with-pictures", source_metrics, source_metrics,
    None, {"significantPicture": True}, None, None, None, identity, True, True
)
print(json.dumps({
    "newEdgeFraction": fidelity.new_edge_fraction,
    "failures": failures,
    "identityMae": identity.mean_absolute_error,
    "identityP99": identity.p99_absolute_error,
    "identityFailures": identity_failures,
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.newEdgeFraction).toBeGreaterThan(0.003);
        expect(report.failures.some((failure: string) => failure.startsWith(
            'introduced-tone-boundaries=',
        ))).toBe(true);
        expect(report.identityMae).toBe(0);
        expect(report.identityP99).toBe(0);
        expect(report.identityFailures).toEqual([]);
    });

    it('accepts ownership-aware cleanup and rejects cut-out tone, washout, dirty blank paper, and deleted margin text', () => {
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image, ImageChops, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

width, height, dpi = 400, 300, 100
source = Image.new("RGB", (width, height), (180, 180, 180))
output = Image.new("RGB", source.size, "white")
source_draw = ImageDraw.Draw(source)
output_draw = ImageDraw.Draw(output)
authored = Image.new("L", (width, height), 0)
authored_draw = ImageDraw.Draw(authored)
for y in range(35, 220, 24):
    source_draw.rectangle((35, y, 165, y + 4), fill=(24, 24, 24))
    output_draw.rectangle((35, y, 165, y + 4), fill=(0, 0, 0))
    authored_draw.rectangle((35, y, 165, y + 4), fill=255)
source_draw.rectangle((8, 8, 12, 15), fill=(20, 20, 20))
output_draw.rectangle((8, 8, 12, 15), fill=(0, 0, 0))
authored_draw.rectangle((8, 8, 12, 15), fill=255)
tone = Image.new("L", (width, height), 0)
ImageDraw.Draw(tone).rectangle((205, 45, 374, 254), fill=255)
for y in range(45, 255):
    for x in range(205, 375):
        value = 36 + ((x * 7 + y * 11) % 180)
        source.putpixel((x, y), (value, value, value))
        output.putpixel((x, y), (value, value, value))
radius = round(dpi * 2.0 / 25.4)
boundary = ImageChops.difference(
    module._binary_dilation(tone, radius),
    module._binary_erosion(tone, radius),
)

def evaluate(candidate, *, blank=False, candidate_authored=authored):
    empty = Image.new("L", (width, height), 0)
    ownership = module.ownership_metrics(
        source, candidate, tone if not blank else empty,
        candidate_authored, boundary if not blank else empty,
        dpi, blank_page=blank,
    )
    fidelity = module.source_fidelity_metrics(
        source, candidate, boundary,
    )
    _, failures = module.page_acceptance_failures(
        "mixed" if not blank else "bw",
        "text-with-pictures" if not blank else "blank",
        module.metrics(source), module.metrics(candidate), None,
        {"significantPicture": not blank},
        None, None, None, fidelity, False, not blank, ownership,
    )
    return ownership, failures

good, good_failures = evaluate(output)
cutout_image = output.copy()
ImageDraw.Draw(cutout_image).rectangle((245, 95, 330, 185), fill="white")
cutout, cutout_failures = evaluate(cutout_image)
washed_image = output.copy()
for y in range(45, 255):
    for x in range(205, 375):
        value = washed_image.getpixel((x, y))[0]
        value = min(255, value + 72)
        washed_image.putpixel((x, y), (value, value, value))
washed, washed_failures = evaluate(washed_image)
deleted_image = output.copy()
ImageDraw.Draw(deleted_image).rectangle((6, 6, 15, 18), fill="white")
deleted, deleted_failures = evaluate(deleted_image)

blank_source = Image.new("RGB", source.size, (192, 192, 192))
blank_output = Image.new("RGB", source.size, "white")
ImageDraw.Draw(blank_output).rectangle((150, 120, 180, 135), fill=(210, 210, 210))
blank_tone = Image.new("L", (width, height), 0)
blank_boundary = Image.new("L", (width, height), 0)
blank_ownership = module.ownership_metrics(
    blank_source, blank_output, blank_tone, blank_tone, blank_boundary,
    dpi, blank_page=True,
)
_, blank_failures = module.page_acceptance_failures(
    "bw", "blank", module.metrics(blank_source), module.metrics(blank_output),
    None, {}, ownership=blank_ownership,
)
print(json.dumps({
    "goodFailures": good_failures,
    "goodSmallRetention": good.small_component_retention,
    "cutoutFailures": cutout_failures,
    "washedFailures": washed_failures,
    "deletedFailures": deleted_failures,
    "deletedMarginRetention": deleted.margin_small_component_retention,
    "blankFailures": blank_failures,
    "blankLargestMm2": blank_ownership.blank_largest_nonwhite_component_mm2,
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.goodFailures).toEqual([]);
        expect(report.goodSmallRetention).toBe(1);
        expect(report.cutoutFailures.some((failure: string) =>
            failure.startsWith('tone-owned-')
            || failure.startsWith('introduced-tone-boundaries='))).toBe(true);
        expect(report.washedFailures.some((failure: string) =>
            failure.startsWith('tone-owned-'))).toBe(true);
        expect(report.deletedFailures).toContain(
            'margin-small-component-retention=0.000<0.900',
        );
        expect(report.deletedMarginRetention).toBe(0);
        expect(report.blankFailures.some((failure: string) =>
            failure.startsWith('blank-nonwhite-component='))).toBe(true);
        expect(report.blankLargestMm2).toBeGreaterThan(0.3);
    });

    it('reports adjacent gray-paper discontinuities only for comparable text pages', () => {
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

source_a_image = Image.new("RGB", (200, 200), (184, 184, 184))
source_b_image = Image.new("RGB", (200, 200), (176, 176, 176))
for image in (source_a_image, source_b_image):
    draw = ImageDraw.Draw(image)
    for y in range(20, 181, 20):
        draw.rectangle((20, y, 180, y + 3), fill=(24, 24, 24))
source_a = module.metrics(source_a_image)
source_b = module.metrics(source_b_image)
white = module.metrics(Image.new("RGB", (200, 200), "white"))
gray = module.metrics(Image.new("RGB", (200, 200), (180, 180, 180)))
def page(number, source, output, candidate=True):
    return module.PageAudit(
        page=number, output_page=number, output_index=0, mode="grayscale",
        rule="bilevel-fidelity", source=source, output=output, crop=None,
        tone=None, seams=module.SeamMetrics(0, 0, 0, 0),
        edge_artifacts=module.EdgeArtifactMetrics(1, 0, 0, 0),
        tone_damage_score=0, gray_severity=0, white_fraction_gain=0,
        dark_fraction_ratio=1, relative_ink_fraction_ratio=1,
        text_cleanup_candidate=candidate, acceptance_failures=(),
    )
comparable = module.neighbor_audits([
    page(1, source_a, white),
    page(2, source_b, gray),
])
protected = module.neighbor_audits([
    page(1, source_a, white),
    page(2, source_b, gray, False),
])
nonadjacent = module.neighbor_audits([
    page(1, source_a, white),
    page(3, source_b, gray),
])
print(json.dumps({
    "comparable": comparable[0].comparable,
    "failures": comparable[0].acceptance_failures,
    "protectedComparable": protected[0].comparable,
    "protectedFailures": protected[0].acceptance_failures,
    "nonadjacentCount": len(nonadjacent),
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.comparable).toBe(true);
        expect(report.failures).toContain('adjacent-paper-discontinuity=75>12,min=180');
        expect(report.failures.some((failure: string) => failure.startsWith(
            'adjacent-gray-field-discontinuity=',
        ))).toBe(true);
        expect(report.protectedComparable).toBe(false);
        expect(report.protectedFailures).toEqual([]);
        expect(report.nonadjacentCount).toBe(0);
    });

    it('refuses source-tone comparison without canonical alignment metadata', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-audit-alignment-test-'));
        temporaryDirectories.push(directory);
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
try:
    module.align_source_to_output(Image.new("RGB", (10, 20)), {}, (30, 40))
except RuntimeError as error:
    print(json.dumps({"error": str(error)}))
else:
    raise AssertionError("missing metadata was silently accepted")
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        const report = JSON.parse(result.stdout);
        expect(report.error).toContain('canonical render metadata');
        expect(report.error).toContain('cropRect');
    });

    it('aligns negative crop margins with the renderer white fill', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'evb-scan-audit-margin-test-'));
        temporaryDirectories.push(directory);
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
source = Image.new("RGB", (10, 10), (90, 40, 20))
metadata = {
    "inputWidthPx": 10,
    "inputHeightPx": 10,
    "cropRect": {"xPx": -2, "yPx": -2, "widthPx": 14, "heightPx": 14},
    "canvasWidthPx": 14,
    "canvasHeightPx": 14,
    "matchedCanvasContentWidthPx": 14,
    "matchedCanvasContentHeightPx": 14,
    "placementOffsetXPx": 0,
    "placementOffsetYPx": 0,
}
aligned = module.align_source_to_output(source, metadata, (14, 14))
print(json.dumps({
    "corner": aligned.getpixel((0, 0)),
    "content": aligned.getpixel((2, 2)),
    "oppositeMargin": aligned.getpixel((13, 13)),
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            corner: [
                255,
                255,
                255,
            ],
            content: [
                90,
                40,
                20,
            ],
            oppositeMargin: [
                255,
                255,
                255,
            ],
        });
    });

    it('aligns split output against its source region rather than the opposite half', () => {
        const scriptPath = resolve('scripts/diagnostics/scan-cleanup-artifact-audit.py');
        const python = String.raw`
import importlib.util, json, sys
from PIL import Image, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_artifact_audit", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
source = Image.new("RGB", (20, 10), (200, 20, 20))
ImageDraw.Draw(source).rectangle((10, 0, 19, 9), fill=(20, 40, 200))
metadata = {
    "inputWidthPx": 20,
    "inputHeightPx": 10,
    "sourceRegion": {"xPx": 10, "yPx": 0, "widthPx": 10, "heightPx": 10},
    "cropRect": {"xPx": 0, "yPx": 0, "widthPx": 10, "heightPx": 10},
    "canvasWidthPx": 10,
    "canvasHeightPx": 10,
    "matchedCanvasContentWidthPx": 10,
    "matchedCanvasContentHeightPx": 10,
    "placementOffsetXPx": 0,
    "placementOffsetYPx": 0,
}
aligned = module.align_source_to_output(source, metadata, (10, 10))
print(json.dumps({
    "left": aligned.getpixel((0, 5)),
    "right": aligned.getpixel((9, 5)),
}))
`;
        const result = spawnSync('python3', [
            '-c',
            python,
            scriptPath,
        ], {encoding: 'utf8'});
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            left: [
                20,
                40,
                200,
            ],
            right: [
                20,
                40,
                200,
            ],
        });
    });
});
