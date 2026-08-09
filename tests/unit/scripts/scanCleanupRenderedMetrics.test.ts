import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const scriptPath = resolve('scripts/diagnostics/scan-cleanup-rendered-metrics.py');

function exerciseMetrics(source: string) {
    const result = spawnSync('python3', [
        '-c',
        source,
        scriptPath,
    ], {encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe('scan cleanup rendered metrics', () => {
    it('selects the exact full-DPI 1-bit JBIG2 row and measures ink', () => {
        const report = exerciseMetrics(String.raw`
import importlib.util, json, sys
from PIL import Image, ImageDraw
spec = importlib.util.spec_from_file_location("scan_cleanup_rendered_metrics", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
listing = """page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
 60 0 image 732 1118 gray 1 8 jpeg no 100 0 120 120 10K 1%
 60 1 stencil 2197 3354 - 1 1 jbig2 no 101 0 360 360 50K 5%
"""
images = module.parse_pdfimages_listing(listing)
selected = module.select_full_resolution_jbig2_mask(images)
mask = Image.new("L", (5, 5), 255)
ImageDraw.Draw(mask).rectangle((1, 1, 3, 3), fill=0)
black, survival = module.stroke_metrics(mask)
expected = Image.new("L", (4, 2), 0)
actual = expected.copy()
ImageDraw.Draw(actual).rectangle((0, 0, 1, 1), fill=255)
print(json.dumps({
    "count": len(images),
    "index": selected.extraction_index,
    "type": selected.image_type,
    "object": selected.object_id,
    "black": black,
    "survival": survival,
    "tiles": module.tile_near_white_deltas(expected, actual, 2),
}))
`);
        expect(report).toMatchObject({
            count: 2,
            index: 1,
            type: 'stencil',
            object: 101,
            black: 36,
            tiles: [
                1,
                0,
            ],
        });
        expect(report.survival).toBeCloseTo(100 / 9, 10);
    });

    it('refuses to guess between same-resolution JBIG2 masks', () => {
        const report = exerciseMetrics(String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("scan_cleanup_rendered_metrics", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
listing = """page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio
 1 0 image 1000 1500 gray 1 1 jbig2 no 10 0 360 360 10K 5%
 1 1 smask 900 1400 gray 1 1 jbig2 no 11 0 360 360 9K 5%
"""
try:
    module.select_full_resolution_jbig2_mask(module.parse_pdfimages_listing(listing))
    error = None
except RuntimeError as caught:
    error = str(caught)
print(json.dumps({"error": error}))
`);
        expect(report.error).toContain('refusing to guess');
        expect(report.error).toContain('object 10');
        expect(report.error).toContain('object 11');
    });

    it('requires pixel-exact decoded masks for symbol safety', () => {
        const report = exerciseMetrics(String.raw`
import importlib.util, json, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_rendered_metrics", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
original = Image.new("1", (4, 4), 1)
original.putpixel((1, 1), 0)
same = original.convert("L")
different = same.copy()
different.putpixel((2, 2), 0)
inverted = module.ImageOps.invert(same)
print(json.dumps({
    "same": module.exact_mask_difference(original, same),
    "inverted": module.exact_mask_difference(original, inverted),
    "different": module.exact_mask_difference(original, different),
}))
`);
        expect(report).toEqual({
            same: 0,
            inverted: 0,
            different: 1,
        });
    });

    it('maps a source crop through deskew, matched-canvas scaling, and placement', () => {
        const report = exerciseMetrics(String.raw`
import importlib.util, json, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_rendered_metrics", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
geometry = {
    "dewarped": False,
    "inputWidthPx": 100,
    "inputHeightPx": 200,
    "canvasWidthPx": 240,
    "canvasHeightPx": 360,
    "cropRect": {"widthPx": 80, "heightPx": 160},
    "outputWidthPx": 80,
    "outputHeightPx": 160,
    "matchedCanvasContentWidthPx": 160,
    "matchedCanvasContentHeightPx": 320,
    "placementOffsetXPx": 30,
    "placementOffsetYPx": 20,
    "forwardTransform": {"matrix": [
        [0.8, -0.1, 5],
        [0.2, 0.9, -10],
        [0, 0, 1],
    ]},
}
affine = module.source_box_to_candidate_affine(
    Image.new("RGB", (240, 360)),
    (100, 200),
    (10, 30, 50, 70),
    geometry,
    "candidate",
)
print(json.dumps({"affine": affine}))
`);
        expect(report.affine).toEqual([
            1.6,
            -0.2,
            50,
            0.4,
            1.8,
            58,
        ]);
    });

    it('rejects non-affine dewarped photo geometry', () => {
        const report = exerciseMetrics(String.raw`
import importlib.util, json, sys
from PIL import Image
spec = importlib.util.spec_from_file_location("scan_cleanup_rendered_metrics", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
try:
    module.source_box_to_candidate_affine(
        Image.new("RGB", (20, 20)),
        (20, 20),
        (1, 1, 10, 10),
        {"dewarped": True},
        "candidate",
    )
    error = None
except ValueError as caught:
    error = str(caught)
print(json.dumps({"error": error}))
`);
        expect(report.error).toContain('dewarped');
        expect(report.error).toContain('affine photo comparison is unavailable');
    });

    it('indexes conversion render geometry by source and output page', () => {
        const report = exerciseMetrics(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("scan_cleanup_rendered_metrics", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as temporary:
    path = Path(temporary) / "summary.json"
    path.write_text(json.dumps({"perPageStreamSizes": [{
        "sourcePageNumber": 49,
        "outputPageNumber": 51,
        "renderGeometry": {"dewarped": False},
    }]}), encoding="utf-8")
    pages = module.load_render_geometry(path, "output")
    print(json.dumps({
        "outputPage": pages[49][0],
        "dewarped": pages[49][1]["dewarped"],
    }))
`);
        expect(report).toEqual({
            outputPage: 51,
            dewarped: false,
        });
    });
});
