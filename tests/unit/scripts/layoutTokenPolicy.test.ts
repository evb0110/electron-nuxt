import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    LAYOUT_TOKEN_POLICY_MAXIMUMS,
    assertLayoutTokenPolicy,
    countLayoutTokenPolicyDebt,
    getLayoutTokenPolicySourceFiles,
    isLayoutTokenPolicySourceExcluded,
} from '@scripts/checkLayoutTokenPolicy';

describe('application chrome layout-token policy', () => {
    it('keeps first-party application chrome free of raw layout-token debt', () => {
        const counts = countLayoutTokenPolicyDebt();

        expect(counts).toEqual(LAYOUT_TOKEN_POLICY_MAXIMUMS);
        expect(() => assertLayoutTokenPolicy(counts)).not.toThrow();
    });

    it('rejects an increase in every tracked debt category', () => {
        for (const category of Object.keys(LAYOUT_TOKEN_POLICY_MAXIMUMS) as Array<keyof typeof LAYOUT_TOKEN_POLICY_MAXIMUMS>) {
            expect(() => assertLayoutTokenPolicy({
                ...LAYOUT_TOKEN_POLICY_MAXIMUMS,
                [category]: LAYOUT_TOKEN_POLICY_MAXIMUMS[category] + 1,
            })).toThrow(category);
        }
    });

    it('covers migrated chrome and viewer components while excluding stylesheet authorities', () => {
        const files = getLayoutTokenPolicySourceFiles();

        expect(files.some(path => path.endsWith('/app/components/AppProgressOverlay.vue'))).toBe(true);
        expect(files.some(path => path.endsWith('/app/assets/css/main.css'))).toBe(false);
        expect(files.some(path => path.includes('/vendor/'))).toBe(false);
        expect(files.some(path => path.endsWith('/app/modules/pdf-viewer/components/PdfSidebar.vue'))).toBe(true);
        expect(files.some(path => path.endsWith('/app/modules/pdf-viewer/components/PdfViewerPage.vue'))).toBe(true);
        expect(files.some(path => path.endsWith('/app/modules/pdf-viewer/components/annotations/PdfAnnotationNoteWindow.vue'))).toBe(true);
        expect(files.some(path => path.endsWith('/app/modules/workspace-shell/components/WorkspaceAnnotationOverlays.vue'))).toBe(true);
    });

    it('does not exempt viewer components by filename', () => {
        expect(isLayoutTokenPolicySourceExcluded('modules/pdf-viewer/components/PdfViewerPage.vue')).toBe(false);
        expect(isLayoutTokenPolicySourceExcluded('assets/css/vendor/pdfjs-viewer-sanitized.css')).toBe(true);
        expect(isLayoutTokenPolicySourceExcluded('modules/example/components/PdfViewerPage.vue')).toBe(false);
        expect(isLayoutTokenPolicySourceExcluded('modules/pdf-viewer/components/MyNoteWindow.vue')).toBe(false);
    });
});
