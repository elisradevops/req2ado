"""Contrast-adaptation and inline-style-safety utilities for table color/
border/width rendering (Phase 2 of
docs/superpowers/specs/2026-08-12-table-fidelity-design.md).

Kept as its own module (rather than folded into tree_builder.py) because it
is a pure, independently-testable unit with zero dependency on the
TableCell/Table grid-walking logic -- every function here is a plain
function of validated primitives (hex strings, floats, enum literals) in,
validated primitives out. tree_builder.py's `_table_to_html` is the only
caller; it threads these results into the HTML it already builds.

Constraint driving everything below: ADO's `System.Description` field only
ever renders ONE literal `style="..."` value -- there is no `<style>` block,
no media query, no runtime dark-mode detection possible from inside the
field's own markup. Every color decision here has to be correct in BOTH of
ADO's themes simultaneously, using nothing but the static string we emit.
"""

from __future__ import annotations

import math
import re

# ---------------------------------------------------------------------------
# Security: style-attribute injection guard (see design spec's "Security:
# style-attribute injection" section). This is the ONLY gate any source-
# document-derived "color" string is allowed to pass through before it can
# reach an inline `style="..."` attribute. Deliberately strict: exactly 7
# characters, `#` + 6 lowercase-or-uppercase hex digits, nothing else --
# no named colors, no rgb()/hsl() functions, no whitespace, no trailing
# garbage. A value that fails this is treated as absent (None), never
# raised on and never passed through -- the loaders are expected to only
# ever produce already-normalized `#rrggbb` or None, so hitting the reject
# path here should never happen in practice, but this check exists
# specifically for the case where it does (defense in depth, not the
# primary correctness mechanism).
# ---------------------------------------------------------------------------
_HEX_COLOR_RE = re.compile(r"^#[0-9a-f]{6}$", re.IGNORECASE)

# Background-normalization threshold: a background whose relative luminance
# exceeds this is treated as "no fill at all", matching Word/Excel's own
# "no fill" default and sidestepping the white-patch-in-dark-mode failure
# mode entirely (see normalize_background's docstring). 0.92 is a
# deliberately generous cutoff -- it catches literal white (L=1.0) and
# near-white off-whites/very-light tints alike, which are visually
# indistinguishable from "no fill" in the vast majority of real documents.
_NO_FILL_LUMINANCE_THRESHOLD = 0.92

# The "genuinely hard case" band (see adapt_text_color_no_background's
# docstring for the full derivation): the range of relative luminance
# values for which a SINGLE literal color can hit >=3:1 contrast against
# BOTH a white background (ADO light theme) and ADO's dark theme surface
# color at once. Simultaneous 4.5:1 both ways is mathematically impossible
# (see below) -- 3:1 both ways is the honest, achievable target.
_NO_BG_LUMINANCE_LOW = 0.139
_NO_BG_LUMINANCE_HIGH = 0.30

# ADO's dark theme surface color is approximately #1f1f1f; its relative
# luminance (via the same linearized-sRGB formula used everywhere in this
# module) is approximately 0.0129. Used as one leg of the no-background
# contrast math and exposed as a named constant so both the implementation
# and its tests derive from the exact same number instead of two
# independently-typed-in copies of "0.0129" silently drifting apart.
ADO_DARK_SURFACE_LUMINANCE = 0.0129

# _scale_luminance_toward's binary search hits its floating-point target
# luminance exactly, but the result is then quantized to an 8-bit-per-
# channel hex string (_linear_rgb_to_hex rounds each channel to the nearest
# integer 0-255) before it's ever compared against anything again -- and
# that rounding measurably shifts the FINAL color's real luminance off the
# search's target. Confirmed empirically: searching for exactly
# _NO_BG_LUMINANCE_LOW (0.139) from #000000 quantizes to a hex color whose
# real luminance is ~0.1384 -- just outside the achievable band, dropping
# its contrast against ADO's dark theme to ~2.958, BELOW the stated 3:1
# floor this whole function exists to guarantee. Targeting the boundary
# exactly is therefore not sufficient; aiming this margin further INTO the
# band (away from the boundary, on the safe side) before quantization
# absorbs that rounding error and keeps the POST-quantization color safely
# inside [_NO_BG_LUMINANCE_LOW, _NO_BG_LUMINANCE_HIGH] in every case tested
# (see test_table_color.py's property-based sweep). 0.003 is comfortably
# larger than the ~0.0006 error actually observed, with room to spare, while
# still being small enough not to meaningfully change how far a color's
# real brightness moves from its source.
_QUANTIZATION_SAFETY_MARGIN = 0.003

# Fallback text colors used whenever neither "pass the source color
# through" nor "the source color itself" is safe to use: whichever of these
# two scores a higher contrast ratio against a given background wins. Not
# pure black/white -- #1b1b1b is a common near-black chosen (per the design
# spec) over #000000 to match typical UI-framework body-text conventions;
# #ffffff is plain white since a light color has no equivalent "soften it
# slightly" convention worth applying here.
SAFE_DARK_TEXT = "#1b1b1b"
SAFE_LIGHT_TEXT = "#ffffff"


def validate_hex_color(value: str | None) -> str | None:
    """The single security gate every color string must pass through
    immediately before use in a style attribute (see module docstring's
    security section). Returns the color lowercased if it matches
    `^#[0-9a-f]{6}$` (case-insensitively), else None -- never raises, never
    passes a malformed value through. Called defensively at the START of
    every public function in this module that accepts a color, not just
    once at the tree_builder.py call site, so no internal helper can
    accidentally skip the check on a new call path added later."""
    if not isinstance(value, str):
        return None
    if _HEX_COLOR_RE.match(value):
        return value.lower()
    return None


# ---------------------------------------------------------------------------
# sRGB <-> linear-light conversion (the IEC 61966-2-1 transfer function).
# This is NOT the same as naively dividing by 255 or using HSL lightness --
# sRGB values are gamma-encoded for display, and perceptual/contrast math
# (WCAG's own relative-luminance formula) is defined in LINEAR light, not
# in the gamma-encoded domain. Skipping this step is the single most common
# mistake in ad hoc "average the RGB channels" luminance code, and it is
# exactly why HSL lightness is the wrong tool for this feature (HSL never
# linearizes at all -- see adapt_text_color_no_background's docstring for
# the concrete #FFFF00 vs #0000FF failure case this avoids).
# ---------------------------------------------------------------------------
def _srgb_to_linear(channel: float) -> float:
    """channel is an sRGB component in [0, 1] (already divided by 255)."""
    if channel <= 0.04045:
        return channel / 12.92
    return ((channel + 0.055) / 1.055) ** 2.4


def _linear_to_srgb(channel: float) -> float:
    """Inverse of _srgb_to_linear. Clamps to [0, 1] first -- the binary
    search in _scale_luminance_toward can produce values imperceptibly
    outside [0, 1] from floating-point rounding at the extremes (t very
    close to 0 or 1), and an out-of-range value here would produce an
    invalid (out of 0-255) byte below."""
    channel = min(max(channel, 0.0), 1.0)
    if channel <= 0.0031308:
        return channel * 12.92
    return 1.055 * (channel ** (1 / 2.4)) - 0.055


def _hex_to_linear_rgb(hex_color: str) -> tuple[float, float, float]:
    """hex_color must already be validated (`#rrggbb`, lowercase) -- this is
    a private helper, not a second security gate."""
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    return _srgb_to_linear(r), _srgb_to_linear(g), _srgb_to_linear(b)


def _linear_rgb_to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{round(_linear_to_srgb(c) * 255):02x}" for c in rgb)


def relative_luminance(hex_color: str) -> float:
    """WCAG relative luminance: a weighted sum of LINEARIZED sRGB channels
    (weights are the standard Rec. 709 luma coefficients WCAG's own formula
    uses). hex_color must already be validated by validate_hex_color --
    this is the shared math primitive every other function in this module
    builds on, called only with already-gated strings."""
    r, g, b = _hex_to_linear_rgb(hex_color)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(hex_a: str, hex_b: str) -> float:
    """The real WCAG contrast ratio formula: (L1 + 0.05) / (L2 + 0.05),
    where L1 is the LIGHTER of the two colors' relative luminance and L2
    the darker -- not simply "first minus second", which would produce a
    ratio below 1.0 (and effectively invert the comparison) whenever the
    caller happens to pass the darker color first. Both inputs must
    already be validated hex colors."""
    l_a, l_b = relative_luminance(hex_a), relative_luminance(hex_b)
    lighter, darker = (l_a, l_b) if l_a >= l_b else (l_b, l_a)
    return (lighter + 0.05) / (darker + 0.05)


def normalize_background(hex_color: str | None) -> str | None:
    """Step 1 of the contrast-adaptation algorithm: treat None AND any
    background whose relative luminance exceeds
    _NO_FILL_LUMINANCE_THRESHOLD (0.92) as "no background at all", and
    return None for both. This runs BEFORE anything else touches the
    background -- a near-white/white fill is normalized away entirely, it
    is never rendered as a literal white box. That matters specifically
    because a literal white `background-color` would look fine in ADO's
    light theme and then glare as an unstyled white patch the instant the
    same work item is viewed in ADO's dark theme -- there is no way to
    conditionally suppress it from inside a single static inline style, so
    the only safe fix is to never emit it in the first place.

    Also doubles as the security gate for background colors specifically
    (via validate_hex_color) -- an invalid/malformed value is treated
    exactly like "no background", never passed through."""
    validated = validate_hex_color(hex_color)
    if validated is None:
        return None
    if relative_luminance(validated) > _NO_FILL_LUMINANCE_THRESHOLD:
        return None
    return validated


def _scale_luminance_toward(hex_color: str, target_luminance: float, toward: str) -> str:
    """Binary-searches a single uniform scale factor `t` in [0, 1] that
    moves hex_color's LINEAR RGB channels toward white (toward="white") or
    toward black (toward="black") until the resulting relative luminance
    hits target_luminance, then re-encodes the result back to sRGB hex.

    Why "toward white/black" and not a flat per-channel multiply: a flat
    multiply (`channel * scale`) can never brighten a channel that starts
    at exactly 0 (0 * anything is still 0), which breaks down precisely on
    the edge cases this feature most needs to handle correctly -- pure
    black (all channels 0) and saturated primaries with a zero channel
    (e.g. #0000FF has R=G=0). Interpolating toward white/black instead
    (`channel + (1-channel)*t` / `channel * (1-t)`) is well-behaved at
    every value in [0, 1] AND has a convenient property: because relative
    luminance is a fixed linear combination of the three channels with
    weights summing to 1, interpolating every channel toward white/black by
    the same `t` interpolates the resulting LUMINANCE toward 1/0 by that
    same `t`, monotonically -- exactly the property a binary search needs
    to converge reliably and exactly what "keep it recognizably the same
    color, just push its lightness" means (only lightness moves; the
    channels' relative proportions relax smoothly toward the white/black
    endpoint rather than any single channel being clipped in isolation).

    hex_color must already be validated. 40 iterations of bisection on a
    unit interval is comfortably enough precision (well under 1e-10) for a
    result that will be rounded to an 8-bit-per-channel hex string anyway."""
    r, g, b = _hex_to_linear_rgb(hex_color)
    brightening = toward == "white"

    def luminance_at(t: float) -> float:
        if brightening:
            rr, gg, bb = (c + (1.0 - c) * t for c in (r, g, b))
        else:
            rr, gg, bb = (c * (1.0 - t) for c in (r, g, b))
        return 0.2126 * rr + 0.7152 * gg + 0.0722 * bb

    lo, hi = 0.0, 1.0
    for _ in range(40):
        mid = (lo + hi) / 2
        mid_luminance = luminance_at(mid)
        # Brightening is monotonically INCREASING in t; darkening is
        # monotonically DECREASING in t -- the bisection direction flips
        # accordingly.
        if brightening:
            if mid_luminance < target_luminance:
                lo = mid
            else:
                hi = mid
        else:
            if mid_luminance > target_luminance:
                lo = mid
            else:
                hi = mid

    final_t = (lo + hi) / 2
    if brightening:
        final_rgb = tuple(c + (1.0 - c) * final_t for c in (r, g, b))
    else:
        final_rgb = tuple(c * (1.0 - final_t) for c in (r, g, b))
    return _linear_rgb_to_hex(final_rgb)


def adapt_text_color_no_background(hex_color: str | None) -> str | None:
    """Step 3 of the contrast-adaptation algorithm -- the genuinely hard
    case: a cell's own text color, with NO background of its own, has to
    read acceptably against whatever ADO's surrounding theme happens to be
    (a near-white page in light theme, a near-black ~#1f1f1f surface in
    dark theme) using nothing but one static color value.

    The math (spelled out here, not just asserted, because a future reader
    needs to see WHY 3:1 and not the usual WCAG AA 4.5:1):
      contrast_against_white(L)    = 1.05 / (L + 0.05)
      contrast_against_ado_dark(L) = (L + 0.05) / (ADO_DARK_SURFACE_LUMINANCE + 0.05)
    Multiplying the two: the (L + 0.05) terms cancel completely, leaving a
    CONSTANT (1.05 / (ADO_DARK_SURFACE_LUMINANCE + 0.05) ~= 16.7) that does
    not depend on L at all. Two numbers whose product is a fixed ~16.7
    cannot both simultaneously be >= 4.5 (that would require a product >=
    20.25) for ANY choice of L -- so WCAG AA against both ADO themes at
    once is mathematically impossible, not just hard to hit with the wrong
    color. The best a single L can do symmetrically is sqrt(16.7) ~= 4.09
    at both sides at once (around L ~= 0.207), still short of 4.5.

    The honest, achievable target is 3:1 both ways, which holds exactly for
    L in [_NO_BG_LUMINANCE_LOW, _NO_BG_LUMINANCE_HIGH] = [0.139, 0.30]
    (solving contrast_against_white(L) = 3 gives L = 0.30;
    solving contrast_against_ado_dark(L) = 3 gives L = 0.139).

    If the source color's real luminance already falls in that band, it is
    passed through COMPLETELY UNCHANGED -- no hue/saturation touch at all,
    per the design spec. Otherwise its luminance is scaled into the
    nearest band edge using LINEARIZED sRGB relative luminance, never HSL
    lightness: HSL lightness treats `#FFFF00` (pure yellow) and `#0000FF`
    (pure blue) as equally "light" (both L=50% in HSL) despite pure
    yellow's real linear luminance being roughly 20x pure blue's -- exactly
    backwards for a "keep it recognizably the same color while nudging its
    effective brightness" requirement, which is why this function is built
    entirely on relative_luminance()/the sRGB transfer functions above and
    never touches colorsys or any HSL conversion.

    Returns None if the input fails hex validation (never raises, never
    passes a bad value through -- see validate_hex_color)."""
    validated = validate_hex_color(hex_color)
    if validated is None:
        return None

    luminance = relative_luminance(validated)
    if _NO_BG_LUMINANCE_LOW <= luminance <= _NO_BG_LUMINANCE_HIGH:
        return validated
    if luminance < _NO_BG_LUMINANCE_LOW:
        target = _NO_BG_LUMINANCE_LOW + _QUANTIZATION_SAFETY_MARGIN
        return _scale_luminance_toward(validated, target, "white")
    target = _NO_BG_LUMINANCE_HIGH - _QUANTIZATION_SAFETY_MARGIN
    return _scale_luminance_toward(validated, target, "black")


def resolve_cell_style_colors(
    background_color: str | None, text_color: str | None
) -> tuple[str | None, str | None]:
    """The full per-cell entry point implementing steps 1-3 of the
    contrast-adaptation algorithm together. Returns
    (background_css, text_css) -- both already validated `#rrggbb` or None,
    safe to interpolate directly into a style attribute.

    - No real background (post-normalize_background): the text color is
      adapted via adapt_text_color_no_background alone (step 3). The
      background side of the pair is always None here.
    - A real background: BOTH background-color and color are always
      returned together (never background alone) -- this is what makes the
      pair theme-independent by construction, since both layers override
      whatever ADO theme is underneath. The source text color is kept
      as-is if its contrast against this exact background is already
      >= 4.5:1 (real WCAG AA, achievable here because both colors are
      fixed and known -- the "impossible product" argument above only
      applies to the no-background case, where one side of the contrast
      pair is an unknown/varying theme color); otherwise whichever of
      SAFE_DARK_TEXT/SAFE_LIGHT_TEXT scores a HIGHER contrast ratio against
      this background wins (not simply "pick white if the background looks
      dark" -- an actual computed comparison, since eyeballing a background
      as "dark" doesn't guarantee which fallback wins for a given hue)."""
    background = normalize_background(background_color)
    if background is not None:
        foreground = validate_hex_color(text_color)
        if foreground is not None and contrast_ratio(foreground, background) >= 4.5:
            return background, foreground
        dark_contrast = contrast_ratio(SAFE_DARK_TEXT, background)
        light_contrast = contrast_ratio(SAFE_LIGHT_TEXT, background)
        fallback = SAFE_DARK_TEXT if dark_contrast >= light_contrast else SAFE_LIGHT_TEXT
        return background, fallback

    return None, adapt_text_color_no_background(text_color)


def border_css(border_style: str | None) -> str | None:
    """Step 4: `border_style in ("grid", "outer")` emits a border
    declaration with NO color component at all -- `border:1px solid` (CSS
    fills in `currentColor` as the implicit default border color for an
    unspecified one, which resolves to whatever text color already applies
    at that point in ADO's OWN theme). That is the entire mechanism this
    relies on for genuine automatic light/dark-theme adaptation: never emit
    a captured/literal border color here, not black, not gray, nothing --
    doing so would silently defeat the whole point of this technique and
    reintroduce exactly the "looks fine in one theme, wrong in the other"
    failure mode borders exist to avoid."""
    if border_style in ("grid", "outer"):
        return "border:1px solid"
    return None


def _clamp_fraction(width: float) -> float:
    """Defense-in-depth clamp for column-width fractions reaching a style
    attribute (see design spec's security section: "floats clamped to a
    sane range" applies here just as much as to colors). column_widths is
    documented as already being fractions of table width by the time it
    reaches this module, never raw source units -- this clamp is a
    guardrail against a malformed/out-of-contract value, not the primary
    mechanism preventing unit leakage (that responsibility lives in the
    loaders, per the model.py field docstring)."""
    if not isinstance(width, (int, float)) or math.isnan(width):
        return 0.0
    return min(max(float(width), 0.0), 1.0)


def colgroup_html(column_widths: list[float] | None) -> str:
    """Step 5: renders `<colgroup><col style="width:NN%">...</colgroup>`,
    one `<col>` per fraction, converted to a percentage. Returns "" (no
    colgroup at all) when column_widths is absent/empty -- the caller is
    responsible for placing this as the FIRST child of `<table>`, before
    `<thead>`/`<tbody>`, per the HTML spec's own required child order for
    `<colgroup>`."""
    if not column_widths:
        return ""
    cols = "".join(
        f'<col style="width:{_clamp_fraction(w) * 100:g}%">' for w in column_widths
    )
    return f"<colgroup>{cols}</colgroup>"


def table_style_attr(border_style: str | None, has_column_widths: bool) -> str:
    """Builds the outer `<table>` tag's own `style="..."` attribute (empty
    string, meaning no attribute at all, when neither a width nor a border
    applies). Two independent concerns share this one attribute:

    - has_column_widths: adds `width:100%` -- colgroup `<col>` percentages
      are only meaningful relative to a table that itself spans a known
      width; without this the browser is free to size the table by content
      instead of by the `<col>` percentages, defeating the colgroup.
    - border_style == "outer": the border wraps the whole table only, so it
      is emitted here on the `<table>` tag itself (as opposed to "grid",
      which is emitted per-cell by the caller in tree_builder.py -- see
      _render_table_row).
    - Either border variant ("grid" or "outer") adds `border-collapse:
      collapse`: without it, adjacent cells' individual borders render as
      doubled/thick lines instead of merging into single shared lines --
      standard practice for any bordered HTML table, and specifically
      needed here since "grid" borders are applied per-cell."""
    parts: list[str] = []
    if has_column_widths:
        parts.append("width:100%")
    border = border_css(border_style)
    if border is not None:
        parts.append("border-collapse:collapse")
        if border_style == "outer":
            parts.append(border)
    if not parts:
        return ""
    return f' style="{"; ".join(parts)}"'
