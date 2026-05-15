import {
    createSSRApp,
    defineComponent,
    ref,
} from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfSkeletonInsets } from '@app/composables/pdf/usePdfSkeletonInsets';
import type {
    IContentInsets,
    PDFPageProxy,
} from '@app/types/pdf';

interface ISkeletonInsetsHarness {skeleton: ReturnType<typeof usePdfSkeletonInsets>;}

async function mountSkeletonInsetsHarness(): Promise<ISkeletonInsetsHarness> {
    const basePageWidth = ref<number | null>(600);
    const basePageHeight = ref<number | null>(800);
    const effectiveScale = ref(1.5);
    let skeleton: ReturnType<typeof usePdfSkeletonInsets> | null = null;
    const app = createSSRApp(defineComponent({setup() {
        skeleton = usePdfSkeletonInsets(basePageWidth, basePageHeight, effectiveScale);
        return () => null;
    }}));

    await renderToString(app);

    if (!skeleton) {
        throw new Error('Failed to mount skeleton insets harness');
    }

    return { skeleton };
}

describe('usePdfSkeletonInsets', () => {
    it('uses stable page-relative insets without probing page text', async () => {
        const { skeleton } = await mountSkeletonInsetsHarness();
        const getTextContent = vi.fn();
        const pdfPage = Object.assign(Object.create(null) as PDFPageProxy, { getTextContent });

        await skeleton.computeSkeletonInsets(pdfPage, 1, () => 1);

        const expectedInsets: IContentInsets = {
            top: 80,
            right: 48,
            bottom: 80,
            left: 48,
        };

        expect(getTextContent).not.toHaveBeenCalled();
        expect(skeleton.skeletonContentInsets.value).toEqual(expectedInsets);
        expect(skeleton.scaledSkeletonPadding.value).toEqual({
            top: 120,
            right: 72,
            bottom: 120,
            left: 72,
        });
    });

    it('ignores stale skeleton inset computations', async () => {
        const { skeleton } = await mountSkeletonInsetsHarness();
        const pdfPage = {} as PDFPageProxy;

        await skeleton.computeSkeletonInsets(pdfPage, 1, () => 2);

        expect(skeleton.skeletonContentInsets.value).toBeNull();
    });
});
