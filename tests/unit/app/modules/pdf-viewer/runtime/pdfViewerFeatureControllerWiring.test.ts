// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createApp,
    defineComponent,
    h,
    ref,
} from 'vue';
import { usePdfViewerFeatureController } from '@app/modules/pdf-viewer/runtime/usePdfViewerFeatureController';
import { createDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { TDocumentPageSourceKind } from '@app/utils/document-viewer/source/documentPageSource';
import type { IDocumentWheelInteraction } from '@app/utils/document-viewer/input/documentWheelInteraction';
import type {
    IPdfViewerEmit,
    IPdfViewerProps,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';

type TFeatureController = ReturnType<typeof usePdfViewerFeatureController>;

function readUserViewportInteractionEpoch(controller: TFeatureController) {
    const readEpoch = controller.pdfViewerPublicApi.getUserViewportInteractionEpoch;
    if (!readEpoch) {
        throw new Error('The viewer public API no longer reports the user viewport interaction epoch.');
    }
    return readEpoch();
}

function createWheelInteraction(
    intent: IDocumentWheelInteraction['intent'],
    deltaPx: number,
): IDocumentWheelInteraction & {event: {preventDefault: ReturnType<typeof vi.fn>}} {
    const preventDefault = vi.fn();
    return {
        deltaPx,
        intent,
        event: {
            cancelable: true,
            clientX: 120,
            clientY: 240,
            defaultPrevented: false,
            deltaX: 0,
            deltaY: deltaPx,
            timeStamp: 0,
            preventDefault,
        },
    };
}

const mountedControllers: Array<() => void> = [];

afterEach(() => {
    mountedControllers.splice(0).forEach(dispose => dispose());
});

function mountFeatureController(props: Partial<IPdfViewerProps> = {}) {
    const emitted: Array<[string, ...unknown[]]> = [];
    const emit = ((event: string, ...args: unknown[]) => {
        emitted.push([
            event,
            ...args,
        ]);
    }) as IPdfViewerEmit;
    const chassisAuthority = createDocumentViewerChassisAuthority(ref<TDocumentPageSourceKind>('pdf'));
    let controller: TFeatureController | null = null;
    const app = createApp(defineComponent({setup() {
        controller = usePdfViewerFeatureController(
            {
                src: null,
                ...props,
            },
            emit,
            chassisAuthority,
        );
        return () => h('div');
    }}));
    const host = document.createElement('div');
    document.body.append(host);
    app.mount(host);
    if (!controller) {
        throw new Error('The feature controller did not construct.');
    }
    mountedControllers.push(() => {
        app.unmount();
        host.remove();
    });
    return {
        controller: controller as TFeatureController,
        emitted,
    };
}

describe('usePdfViewerFeatureController wiring', () => {
    it('publishes the viewer container to the public API and releases it again', () => {
        const harness = mountFeatureController();
        const container = document.createElement('div');

        harness.controller.handleViewerContainerRef(container);
        expect(harness.controller.pdfViewerPublicApi.getViewerContainer()).toBe(container);

        harness.controller.handleViewerContainerRef(null);
        expect(harness.controller.pdfViewerPublicApi.getViewerContainer()).toBeNull();
    });

    it('routes a modifier wheel packet into the zoom path', () => {
        const harness = mountFeatureController({src: new Blob([], {type: 'application/pdf'})});
        harness.controller.handleViewerContainerRef(document.createElement('div'));
        const interaction = createWheelInteraction('zoom', -120);

        harness.controller.handleViewerWheel(interaction);

        expect(interaction.event.preventDefault).toHaveBeenCalledTimes(1);
        expect(harness.emitted).toContainEqual([
            'update:zoomMode',
            'custom',
        ]);
        const zoomUpdate = harness.emitted.find(([event]) => event === 'update:zoom');
        expect(zoomUpdate?.[1]).toEqual(expect.any(Number));
        expect(zoomUpdate?.[1]).toBeGreaterThan(1);
    });

    it('routes a plain wheel packet to the viewport session as a user interaction', () => {
        const harness = mountFeatureController({continuousScroll: true});
        const before = readUserViewportInteractionEpoch(harness.controller);
        const interaction = createWheelInteraction('scroll', 120);

        harness.controller.handleViewerWheel(interaction);

        expect(interaction.event.preventDefault).not.toHaveBeenCalled();
        expect(readUserViewportInteractionEpoch(harness.controller)).toBeGreaterThan(before);
    });
});
