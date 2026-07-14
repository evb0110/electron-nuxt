// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    capturePaneRelocationScroll,
    restorePaneRelocationScroll,
} from '@app/modules/workspace-shell/layout/preservePaneRelocationScroll';

describe('pane relocation scroll preservation', () => {
    it('restores only scroll roots that opt into the pane relocation contract', () => {
        const host = document.createElement('div');
        const thumbnailRail = document.createElement('div');
        const unrelatedScroller = document.createElement('div');
        thumbnailRail.dataset.preservePaneRelocationScroll = '';
        thumbnailRail.scrollLeft = 12;
        thumbnailRail.scrollTop = 4_200;
        unrelatedScroller.scrollTop = 900;
        host.append(thumbnailRail, unrelatedScroller);
        document.body.append(host);

        const snapshots = capturePaneRelocationScroll(host);
        thumbnailRail.scrollLeft = 0;
        thumbnailRail.scrollTop = 0;
        unrelatedScroller.scrollTop = 0;

        expect(restorePaneRelocationScroll(snapshots)).toBe(1);
        expect(thumbnailRail.scrollLeft).toBe(12);
        expect(thumbnailRail.scrollTop).toBe(4_200);
        expect(unrelatedScroller.scrollTop).toBe(0);
    });

    it('does not write stale elements after their pane has been removed', () => {
        const host = document.createElement('div');
        const rail = document.createElement('div');
        rail.dataset.preservePaneRelocationScroll = '';
        rail.scrollTop = 800;
        host.append(rail);
        document.body.append(host);

        const snapshots = capturePaneRelocationScroll(host);
        rail.remove();
        rail.scrollTop = 0;

        expect(restorePaneRelocationScroll(snapshots)).toBe(0);
        expect(rail.scrollTop).toBe(0);
    });

    it('keeps the same virtual item at the same viewport position when layout geometry changes', () => {
        const host = document.createElement('div');
        const rail = document.createElement('div');
        const item = document.createElement('div');
        rail.dataset.preservePaneRelocationScroll = '';
        item.dataset.paneRelocationScrollItem = '';
        rail.append(item);
        host.append(rail);
        document.body.append(host);
        rail.scrollTop = 1_000;
        let itemLayoutTop = 1_100;
        rail.getBoundingClientRect = () => ({
            bottom: 500,
            height: 400,
            left: 0,
            right: 200,
            top: 100,
            width: 200,
            x: 0,
            y: 100,
            toJSON: () => ({}),
        });
        item.getBoundingClientRect = () => ({
            bottom: 100 + itemLayoutTop - rail.scrollTop + 160,
            height: 160,
            left: 0,
            right: 180,
            top: 100 + itemLayoutTop - rail.scrollTop,
            width: 180,
            x: 0,
            y: 100 + itemLayoutTop - rail.scrollTop,
            toJSON: () => ({}),
        });

        const snapshots = capturePaneRelocationScroll(host);
        itemLayoutTop = 1_500;
        rail.scrollTop = 0;

        expect(restorePaneRelocationScroll(snapshots)).toBe(1);
        expect(rail.scrollTop).toBe(1_400);
        expect(
            item.getBoundingClientRect().top
            + (item.getBoundingClientRect().height * 0.625)
            - rail.getBoundingClientRect().top,
        ).toBe(200);
    });
});
