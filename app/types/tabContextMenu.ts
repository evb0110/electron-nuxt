import type { TPaneDirection } from '@app/types/editorPanes';

export type TDirectionalCommandAvailability = Record<TPaneDirection, boolean>;

export interface ITabContextAvailability {
    split: TDirectionalCommandAvailability;
    splitEmpty: TDirectionalCommandAvailability;
    focus: TDirectionalCommandAvailability;
    move: TDirectionalCommandAvailability;
    copy: TDirectionalCommandAvailability;
    canClose: boolean;
    canCreate: boolean;
    canMoveToNewWindow: boolean;
}

export type TTabContextCommand =
    | { kind: 'new-tab' }
    | { kind: 'close-tab' }
    | { kind: 'move-to-new-window'; }
    | {
        kind: 'move-to-window';
        targetWindowId: number;
    }
    | {
        kind: 'split';
        direction: TPaneDirection
    }
    | {
        kind: 'split-empty';
        direction: TPaneDirection
    }
    | {
        kind: 'focus';
        direction: TPaneDirection
    }
    | {
        kind: 'move';
        direction: TPaneDirection
    }
    | {
        kind: 'copy';
        direction: TPaneDirection
    };

export type TDirectionalTabContextCommand = Extract<TTabContextCommand, { direction: TPaneDirection }>;
