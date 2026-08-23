import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface INativeCorpusModule {getNativeCorpusTestCommands: () => string[][];}

const corpusRunner = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/run-native-corpus-tests.mjs'),
).href) as INativeCorpusModule;

describe('native corpus test lane', () => {
    it('runs every locally ignored expensive test by exact name', () => {
        const commands = corpusRunner.getNativeCorpusTestCommands();
        expect(commands).toHaveLength(17);
        expect(commands.every(command => (
            command.includes('--ignored') && command.includes('--exact')
        ))).toBe(true);
        expect(commands.map(command => command.join(' '))).toEqual(expect.arrayContaining([
            expect.stringContaining('real_hard_cases_and_spread_controls_follow_stage_b_policy'),
            expect.stringContaining('luther_low_resolution_scans_keep_soft_text_in_grayscale'),
            expect.stringContaining('luther_soft_gutter_batch_is_consistently_high_confidence'),
            expect.stringContaining('document_reconciliation_never_touches_manual_layouts'),
            expect.stringContaining('document_prior_is_gated_at_full_resolution_before_analysis_downscaling'),
            expect.stringContaining('real_gray_flyleaf_is_white_and_consistent_in_preview_and_final_cli_renders'),
            expect.stringContaining('forced_bw_matched_canvas_routes_the_blank_verso_corner_rail_out_of_publication'),
            expect.stringContaining('over_analysis_edge_spread_analysis_matches_canonical_leaf_ink_and_content'),
            expect.stringContaining('auto_small_picture_uses_mixed_but_explicit_bw_stays_bilevel'),
            expect.stringContaining(
                'luther_style_fragmented_gutter_does_not_pin_crop_even_when_tone_marks_it_as_picture',
            ),
            expect.stringContaining('cli_content_box_only_inherits_local_rejected_rail_authority'),
            expect.stringContaining('cli_crop_keeps_a_flat_shaded_plate_no_picture_detector_claims'),
            expect.stringContaining('page_seven_twin_protects_picture_and_heading_in_every_output_mode'),
            expect.stringContaining('auto_mode_turns_dark_text_on_uniform_tinted_paper_into_black_on_white'),
        ]));
    });
});
