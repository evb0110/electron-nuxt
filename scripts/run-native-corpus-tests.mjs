#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const baseArgs = [
    'test',
    '--manifest-path',
    'native/Cargo.toml',
    '--locked',
    '-p',
    'evb-scan-cleanup',
];

export function getNativeCorpusTestCommands() {
    return [
        [
            ...baseArgs,
            '--test',
            'split_real_fixtures',
            'real_hard_cases_and_spread_controls_follow_stage_b_policy',
            '--',
            '--ignored',
            '--exact',
        ],
        [
            ...baseArgs,
            '--test',
            'mode_select_real',
            'luther_low_resolution_scans_keep_soft_text_in_grayscale',
            '--',
            '--ignored',
            '--exact',
        ],
        ...[
            'luther_soft_gutter_batch_is_consistently_high_confidence',
            'document_reconciliation_never_touches_manual_layouts',
        ].map(testName => [
            ...baseArgs,
            '--test',
            'detect_document_consistency',
            testName,
            '--',
            '--ignored',
            '--exact',
        ]),
        ...[
            'real_gray_flyleaf_is_white_and_consistent_in_preview_and_final_cli_renders',
            'real_gray_flyleaf_stays_white_when_auto_was_pre_resolved_to_grayscale',
            'spread_preview_cli_pins_the_small_print_stroke_budget_outcome',
            'off_center_binding_fold_does_not_promote_the_spread_to_mixed',
            'forced_bw_matched_canvas_routes_the_blank_verso_corner_rail_out_of_publication',
            'over_analysis_edge_spread_analysis_matches_canonical_leaf_ink_and_content',
            'auto_small_picture_uses_mixed_but_explicit_bw_stays_bilevel',
            'luther_style_fragmented_gutter_does_not_pin_crop_even_when_tone_marks_it_as_picture',
            'cli_content_box_only_inherits_local_rejected_rail_authority',
            'cli_crop_keeps_a_flat_shaded_plate_no_picture_detector_claims',
        ].map(testName => [
            ...baseArgs,
            '--test',
            'page_cli',
            testName,
            '--',
            '--ignored',
            '--exact',
        ]),
        ...[
            'engine::render::tests::document_prior_is_gated_at_full_resolution_before_analysis_downscaling',
            'engine::render::tests::page_seven_twin_protects_picture_and_heading_in_every_output_mode',
            'engine::render::tests::auto_mode_turns_dark_text_on_uniform_tinted_paper_into_black_on_white',
        ].map(testName => [
            ...baseArgs,
            '--lib',
            testName,
            '--',
            '--ignored',
            '--exact',
        ]),
    ];
}

export function runNativeCorpusTests() {
    for (const args of getNativeCorpusTestCommands()) {
        const result = spawnSync('cargo', args, {
            cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
            stdio: 'inherit',
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`cargo ${args.join(' ')} failed with status ${result.status ?? 1}`);
        }
    }
}

const isDirectCliRun = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectCliRun) {
    try {
        runNativeCorpusTests();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}
