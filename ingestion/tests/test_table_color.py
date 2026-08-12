# ingestion/tests/test_table_color.py
from app.leveling.table_color import (
    ADO_DARK_SURFACE_LUMINANCE,
    SAFE_DARK_TEXT,
    SAFE_LIGHT_TEXT,
    adapt_text_color_no_background,
    border_css,
    colgroup_html,
    contrast_ratio,
    normalize_background,
    relative_luminance,
    resolve_cell_style_colors,
    table_style_attr,
    validate_hex_color,
)

# ---------------------------------------------------------------------------
# validate_hex_color -- the security gate every color must pass through.
# ---------------------------------------------------------------------------


def test_validate_hex_color_accepts_a_well_formed_lowercase_hex() -> None:
    assert validate_hex_color("#ff00aa") == "#ff00aa"


def test_validate_hex_color_lowercases_an_uppercase_hex() -> None:
    assert validate_hex_color("#FF00AA") == "#ff00aa"


def test_validate_hex_color_rejects_none() -> None:
    assert validate_hex_color(None) is None


def test_validate_hex_color_rejects_a_named_color() -> None:
    assert validate_hex_color("red") is None


def test_validate_hex_color_rejects_rgb_function_syntax() -> None:
    assert validate_hex_color("rgb(255, 0, 0)") is None


def test_validate_hex_color_rejects_a_short_hex() -> None:
    assert validate_hex_color("#f0a") is None


def test_validate_hex_color_rejects_css_injection_shaped_garbage() -> None:
    # Real defense-in-depth proof, per the design spec's security section --
    # this must never be reachable from a real loader today, but the guard
    # must independently reject it if it ever were.
    assert validate_hex_color('#ffffff; } body { background: red') is None
    assert validate_hex_color('#ffffff" onmouseover="alert(1)') is None


# ---------------------------------------------------------------------------
# relative_luminance / contrast_ratio -- the shared math primitives.
# ---------------------------------------------------------------------------


def test_relative_luminance_of_pure_white_is_one() -> None:
    assert relative_luminance("#ffffff") == 1.0


def test_relative_luminance_of_pure_black_is_zero() -> None:
    assert relative_luminance("#000000") == 0.0


def test_relative_luminance_uses_linearized_srgb_not_naive_average() -> None:
    # Confirms the module isn't secretly doing a naive (R+G+B)/3 average --
    # under linearized sRGB, pure green (#00ff00) is dramatically brighter
    # than pure blue (#0000ff), reflecting the human eye's real sensitivity
    # (Rec. 709 luma weights: G=0.7152 vs B=0.0722) -- a naive average would
    # report both as identical (each is a single maxed channel / 3).
    green_luminance = relative_luminance("#00ff00")
    blue_luminance = relative_luminance("#0000ff")
    assert green_luminance > blue_luminance * 5


def test_contrast_ratio_of_black_and_white_is_21_to_1() -> None:
    # The maximum possible WCAG contrast ratio, a well-known reference value.
    assert abs(contrast_ratio("#000000", "#ffffff") - 21.0) < 0.01


def test_contrast_ratio_of_a_color_against_itself_is_1_to_1() -> None:
    assert contrast_ratio("#336699", "#336699") == 1.0


def test_contrast_ratio_is_order_independent() -> None:
    # Real regression target: a naive "first minus second" (or divide
    # without picking the lighter/darker first) would produce a DIFFERENT,
    # inverted-looking result depending on argument order.
    assert contrast_ratio("#000000", "#ffffff") == contrast_ratio("#ffffff", "#000000")


# ---------------------------------------------------------------------------
# normalize_background -- step 1: near-white/white -> None.
# ---------------------------------------------------------------------------


def test_normalize_background_treats_pure_white_as_no_fill() -> None:
    assert normalize_background("#ffffff") is None


def test_normalize_background_treats_a_near_white_tint_as_no_fill() -> None:
    assert normalize_background("#fdfdfd") is None


def test_normalize_background_keeps_a_real_saturated_color() -> None:
    assert normalize_background("#fff2cc") == "#fff2cc"  # a real pale-yellow header tint, below the threshold


def test_normalize_background_keeps_a_strongly_colored_background() -> None:
    assert normalize_background("#c62828") == "#c62828"


def test_normalize_background_treats_none_as_no_fill() -> None:
    assert normalize_background(None) is None


def test_normalize_background_rejects_a_malformed_value_as_no_fill() -> None:
    assert normalize_background("not-a-color") is None


# ---------------------------------------------------------------------------
# adapt_text_color_no_background -- step 3, the genuinely hard case, and the
# module's own stated acceptance criterion: for ANY input color, the
# adapted output must hit >= 3:1 contrast against BOTH a white background
# (ADO light theme) and ADO's real dark-theme surface color, simultaneously.
# This is a property-based test over a representative spread of colors, not
# just example-based spot checks -- the whole point of the algorithm is that
# this property holds for every input, not just a few hand-picked ones.
# ---------------------------------------------------------------------------

_CONTRAST_FLOOR = 3.0
_ADO_DARK_SURFACE_HEX = "#1f1f1f"  # matches the module's own documented approximation


def _min_contrast_both_themes(hex_color: str) -> float:
    return min(
        contrast_ratio(hex_color, "#ffffff"),
        contrast_ratio(hex_color, _ADO_DARK_SURFACE_HEX),
    )


_REPRESENTATIVE_COLORS = [
    "#000000",  # pure black -- far below the band, needs brightening
    "#ffffff",  # pure white -- far above the band, needs darkening
    "#ff0000",  # pure red
    "#00ff00",  # pure green -- highest single-channel luminance weight
    "#0000ff",  # pure blue -- lowest single-channel luminance weight
    "#ffff00",  # pure yellow -- the HSL-vs-linear-luminance failure case the design spec calls out by name
    "#808080",  # mid gray
    "#336699",  # a plausible real "brand blue" text color
    "#7a7a3a",  # a color whose luminance already falls inside the achievable band -- should pass through unchanged
    "#c0c0c0",  # light gray, near but not at the no-fill threshold
    "#101010",  # near-black, but not exactly black
    "#fefefe",  # near-white, but not exactly white
]


def test_adapt_text_color_no_background_hits_the_3_to_1_floor_against_both_themes_for_every_representative_color() -> None:
    for source_color in _REPRESENTATIVE_COLORS:
        adapted = adapt_text_color_no_background(source_color)
        assert adapted is not None, f"{source_color} unexpectedly failed validation"
        min_contrast = _min_contrast_both_themes(adapted)
        assert min_contrast >= _CONTRAST_FLOOR - 1e-9, (
            f"source={source_color} adapted={adapted} min_contrast={min_contrast:.3f} "
            f"-- below the {_CONTRAST_FLOOR}:1 floor against one of the two ADO themes"
        )


def test_adapt_text_color_no_background_passes_through_unchanged_when_already_in_band() -> None:
    # A color already inside [0.139, 0.30] real relative luminance must not
    # be touched at all -- no hue/saturation drift for a color that already
    # satisfies the constraint.
    in_band_color = "#7a7a3a"
    assert relative_luminance(in_band_color) >= 0.139
    assert relative_luminance(in_band_color) <= 0.30
    assert adapt_text_color_no_background(in_band_color) == in_band_color


def test_adapt_text_color_no_background_brightens_pure_black_into_the_band() -> None:
    # Real per-input assertion, not just the aggregate contrast-floor sweep
    # below: proves the OUTPUT's real (post-8-bit-quantization) luminance
    # genuinely lands inside the achievable band -- not just "close to it",
    # which is exactly the property the quantization-safety-margin fix
    # exists to guarantee (see table_color.py's _QUANTIZATION_SAFETY_MARGIN
    # docstring for the concrete boundary-overshoot bug this test would have
    # caught before that fix).
    adapted = adapt_text_color_no_background("#000000")
    luminance = relative_luminance(adapted)
    assert 0.139 <= luminance <= 0.30


def test_adapt_text_color_no_background_darkens_pure_white_into_the_band() -> None:
    adapted = adapt_text_color_no_background("#ffffff")
    luminance = relative_luminance(adapted)
    assert 0.139 <= luminance <= 0.30


def test_adapt_text_color_no_background_preserves_hue_direction_for_pure_yellow() -> None:
    # The design spec's own named failure case for HSL lightness: pure
    # yellow (#ffff00) must remain RECOGNIZABLY yellow after adaptation
    # (R and G channels staying much higher than B), not collapse toward a
    # generic gray the way a channel-averaging approach might.
    adapted = adapt_text_color_no_background("#ffff00")
    r, g, b = (int(adapted[i : i + 2], 16) for i in (1, 3, 5))
    assert r > b
    assert g > b


def test_adapt_text_color_no_background_returns_none_for_a_malformed_color() -> None:
    assert adapt_text_color_no_background("not-a-color") is None


def test_adapt_text_color_no_background_returns_none_for_none() -> None:
    assert adapt_text_color_no_background(None) is None


def test_ado_dark_surface_luminance_constant_matches_the_documented_approximation() -> None:
    # Guards against the implementation's inline "~0.0129" and this test's
    # own reference value silently drifting apart from the named constant
    # the module actually exports and uses.
    assert abs(ADO_DARK_SURFACE_LUMINANCE - relative_luminance(_ADO_DARK_SURFACE_HEX)) < 0.001


# ---------------------------------------------------------------------------
# resolve_cell_style_colors -- steps 1-3 together, the real per-cell entry
# point tree_builder.py actually calls.
# ---------------------------------------------------------------------------


def test_resolve_cell_style_colors_with_no_background_adapts_text_color_alone() -> None:
    background_css, text_css = resolve_cell_style_colors(None, "#000000")
    assert background_css is None
    assert text_css is not None
    assert _min_contrast_both_themes(text_css) >= _CONTRAST_FLOOR - 1e-9


def test_resolve_cell_style_colors_with_no_background_and_no_text_color_returns_both_none() -> None:
    assert resolve_cell_style_colors(None, None) == (None, None)


def test_resolve_cell_style_colors_keeps_source_text_color_when_contrast_already_sufficient() -> None:
    # A real high-contrast pair (near-black text on a pale-yellow
    # background) -- the source text color must be kept AS-IS, not swapped
    # to a fallback, since real WCAG AA (4.5:1) is achievable here (both
    # colors are fixed and known, unlike the no-background case).
    background_css, text_css = resolve_cell_style_colors("#fff2cc", "#1b1b1b")
    assert background_css == "#fff2cc"
    assert text_css == "#1b1b1b"
    assert contrast_ratio("#fff2cc", "#1b1b1b") >= 4.5


def test_resolve_cell_style_colors_swaps_to_a_fallback_when_source_text_contrast_is_insufficient() -> None:
    # A background/text pair with real but insufficient contrast (both
    # mid-toned) -- the text color must be REPLACED by whichever fallback
    # (SAFE_DARK_TEXT/SAFE_LIGHT_TEXT) scores higher, not passed through.
    background_css, text_css = resolve_cell_style_colors("#a0a0a0", "#909090")
    assert background_css == "#a0a0a0"
    assert text_css in (SAFE_DARK_TEXT, SAFE_LIGHT_TEXT)
    assert contrast_ratio("#a0a0a0", text_css) >= contrast_ratio("#a0a0a0", "#909090")


def test_resolve_cell_style_colors_picks_the_higher_contrast_fallback_not_a_fixed_default() -> None:
    # A real computed comparison, not "always pick white for a dark-looking
    # background" -- prove both fallback directions are reachable.
    _, light_bg_text = resolve_cell_style_colors("#f5f5f0", "#eeeeee")  # very light bg, low-contrast text
    assert light_bg_text == SAFE_DARK_TEXT  # dark text wins against a light background

    _, dark_bg_text = resolve_cell_style_colors("#202020", "#303030")  # very dark bg, low-contrast text
    assert dark_bg_text == SAFE_LIGHT_TEXT  # light text wins against a dark background


def test_resolve_cell_style_colors_never_returns_background_alone() -> None:
    # Load-bearing invariant from the design spec: a real background ALWAYS
    # comes with a text color too (never background-only), since the pair
    # being set TOGETHER is what makes it theme-independent.
    background_css, text_css = resolve_cell_style_colors("#c62828", None)
    assert background_css == "#c62828"
    assert text_css is not None


def test_resolve_cell_style_colors_normalizes_a_near_white_background_to_no_fill() -> None:
    background_css, text_css = resolve_cell_style_colors("#fefefe", "#000000")
    assert background_css is None
    # Falls through to the no-background text-adaptation path.
    assert text_css is not None
    assert _min_contrast_both_themes(text_css) >= _CONTRAST_FLOOR - 1e-9


def test_resolve_cell_style_colors_rejects_a_malformed_background() -> None:
    background_css, _ = resolve_cell_style_colors("javascript:alert(1)", "#000000")
    assert background_css is None


# ---------------------------------------------------------------------------
# border_css -- step 4: currentColor-based theme adaptation.
# ---------------------------------------------------------------------------


def test_border_css_grid_emits_border_with_no_color() -> None:
    css = border_css("grid")
    assert css == "border:1px solid"
    assert "#" not in css  # no literal color anywhere -- currentColor is implicit


def test_border_css_outer_emits_the_same_colorless_border() -> None:
    assert border_css("outer") == "border:1px solid"


def test_border_css_none_emits_nothing() -> None:
    assert border_css("none") is None


def test_border_css_absent_emits_nothing() -> None:
    assert border_css(None) is None


# ---------------------------------------------------------------------------
# colgroup_html -- step 5: column-width fractions as percentages.
# ---------------------------------------------------------------------------


def test_colgroup_html_renders_one_col_per_fraction_as_a_percentage() -> None:
    html = colgroup_html([0.5, 0.25, 0.25])
    assert html == '<colgroup><col style="width:50%"><col style="width:25%"><col style="width:25%"></colgroup>'


def test_colgroup_html_returns_empty_string_for_none() -> None:
    assert colgroup_html(None) == ""


def test_colgroup_html_returns_empty_string_for_an_empty_list() -> None:
    assert colgroup_html([]) == ""


def test_colgroup_html_clamps_an_out_of_range_fraction() -> None:
    # Defense-in-depth per the module's own _clamp_fraction docstring --
    # column_widths is documented as always a real fraction by the time it
    # reaches here, but a malformed value must not produce invalid CSS
    # (e.g. a negative or >100% width).
    html = colgroup_html([1.5, -0.2])
    assert html == '<colgroup><col style="width:100%"><col style="width:0%"></colgroup>'


# ---------------------------------------------------------------------------
# table_style_attr -- the outer <table> tag's own style attribute.
# ---------------------------------------------------------------------------


def test_table_style_attr_empty_when_no_width_and_no_border() -> None:
    assert table_style_attr(None, False) == ""
    assert table_style_attr("none", False) == ""


def test_table_style_attr_width_only_when_column_widths_present_and_no_border() -> None:
    assert table_style_attr(None, True) == ' style="width:100%"'


def test_table_style_attr_outer_border_includes_border_collapse_and_the_border_itself() -> None:
    css = table_style_attr("outer", False)
    assert 'border-collapse:collapse' in css
    assert 'border:1px solid' in css


def test_table_style_attr_grid_border_includes_border_collapse_but_not_the_border_itself() -> None:
    # "grid" borders are applied PER-CELL by the caller (tree_builder.py),
    # not on the <table> tag itself -- only border-collapse belongs here
    # for the grid case, per table_style_attr's own docstring.
    css = table_style_attr("grid", False)
    assert 'border-collapse:collapse' in css
    assert css.count('border:1px solid') == 0


def test_table_style_attr_combines_width_and_outer_border() -> None:
    css = table_style_attr("outer", True)
    assert 'width:100%' in css
    assert 'border-collapse:collapse' in css
    assert 'border:1px solid' in css
