import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ISyncPdfjsViewerCssModule {
    collectReferencedImages: (cssText: string) => string[];
    normalizeWhitespace: (cssText: string) => string;
    removeUnusedUiBlocks: (cssText: string) => string;
    rewriteImageUrls: (cssText: string, sourceImageNames: string[]) => string;
}

const {
    collectReferencedImages,
    normalizeWhitespace,
    removeUnusedUiBlocks,
    rewriteImageUrls,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/sync-pdfjs-viewer-css.mjs')).href) as ISyncPdfjsViewerCssModule;

describe('PDF.js viewer CSS sync', () => {
    it('removes every tracked unused upstream UI block and fails when a pattern goes stale', () => {
        const sanitized = removeUnusedUiBlocks(`
.dialog.newAltText {
  color: red;
}

#viewsManager {
  color: red;
}

@media screen {
  #outerContainer.viewsManager {
    color: red;
  }

  .keptRule {
    color: green;
  }
}
`);

        expect(sanitized).not.toContain('.dialog.newAltText');
        expect(sanitized).not.toContain('#viewsManager');
        expect(sanitized).not.toContain('#outerContainer.viewsManager');
        expect(sanitized).toContain('.keptRule');
        expect(() => removeUnusedUiBlocks('.dialog.newAltText { color: red; }'))
            .toThrow('PDF.js viewer CSS removal pattern(s) no longer match upstream css');
    });

    it('rewrites referenced PDF.js images and removes declarations for missing assets', () => {
        const rewritten = rewriteImageUrls(`
.toolbarButton {
  background-image: url("images/toolbarButton-menuArrow.svg");
}

.missingIcon {
  background-image: url(images/missing.svg);
}
`, ['toolbarButton-menuArrow.svg']);
        const normalized = normalizeWhitespace(rewritten);

        expect(normalized).toContain('url(\'/pdfjs/images/toolbarButton-menuArrow.svg\')');
        expect(normalized).not.toContain('missing.svg');
        expect(collectReferencedImages(normalized)).toEqual(['toolbarButton-menuArrow.svg']);
    });
});
