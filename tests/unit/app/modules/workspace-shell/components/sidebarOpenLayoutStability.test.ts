// @vitest-environment happy-dom

import {
    createApp,
    defineComponent,
    h,
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { SIDEBAR } from '@app/constants/pdfLayout';
import WorkspaceSidebarHost from '@app/modules/workspace-shell/components/layout/WorkspaceSidebarHost.vue';

function mountHost() {
    const host = document.createElement('div');
    document.body.append(host);
    const showSidebar = ref(false);
    const app = createApp(defineComponent({setup: () => () => h(WorkspaceSidebarHost, {
        isResizingSidebar: false,
        resizeAriaLabel: 'Resize sidebar',
        showSidebar: showSidebar.value,
        sidebarContentWidth: SIDEBAR.DEFAULT_WIDTH,
        sidebarWrapperStyle: {width: `${String(SIDEBAR.DEFAULT_WIDTH + SIDEBAR.RESIZER_WIDTH)}px`},
    }, {sidebar: () => h('div', {class: 'panel'})})}));
    app.mount(host);
    return {
        dispose() {
            app.unmount();
            host.remove();
        },
        content: () => host.querySelector<HTMLElement>('.sidebar-wrapper__content'),
        showSidebar,
        wrapper: () => host.querySelector<HTMLElement>('.sidebar-wrapper'),
    };
}

describe('sidebar open layout stability', () => {
    it('gives the panel its open width on the first frame of the slide', async () => {
        const view = mountHost();
        await nextTick();

        expect(view.wrapper()?.style.width).toBe('0px');
        expect(view.content()?.style.width).toBe('0px');
        expect(view.content()?.querySelector('.panel')).not.toBeNull();

        view.showSidebar.value = true;
        await nextTick();

        // The wrapper animates its width open. The panel jumps straight to the
        // final width so the thumbnail rail measures one width instead of
        // relaying out and re-rasterizing on every frame of the animation.
        expect(view.wrapper()?.style.width).toBe(`${String(SIDEBAR.DEFAULT_WIDTH + SIDEBAR.RESIZER_WIDTH)}px`);
        expect(view.content()?.style.width).toBe(`${String(SIDEBAR.DEFAULT_WIDTH)}px`);

        view.dispose();
    });

    it('collapses the panel back to zero so a closed sidebar cannot measure as visible', async () => {
        const view = mountHost();
        view.showSidebar.value = true;
        await nextTick();
        view.showSidebar.value = false;
        await nextTick();

        expect(view.content()?.style.width).toBe('0px');
        expect(view.wrapper()?.classList.contains('is-closed')).toBe(true);

        view.dispose();
    });
});
