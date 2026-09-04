//! Username colors.
//!
//! Twitch's `color` tag is empty for anyone who never picked a color; the web
//! client assigns one deterministically from a fixed palette. We reproduce that
//! so every chatter gets a stable color, then lift very dark colors so they stay
//! legible on our near-black background (the classic offender is #0000FF).

/// The palette Twitch's own client uses for users with no color set.
const DEFAULT_COLORS: [&str; 15] = [
    "#FF0000", "#0000FF", "#00FF00", "#B22222", "#FF7F50", "#9ACD32", "#FF4500", "#2E8B57",
    "#DAA520", "#D2691E", "#5F9EA0", "#1E90FF", "#FF69B4", "#8A2BE2", "#00FF7F",
];

/// The chat background these colors are read against (--color-surface).
const BACKGROUND: (f32, f32, f32) = (
    0x0b as f32 / 255.0,
    0x0b as f32 / 255.0,
    0x0f as f32 / 255.0,
);
/// Target WCAG contrast ratio. 4.5 is the AA threshold for body text.
const MIN_CONTRAST: f32 = 4.5;
/// Lightness is raised in steps until the target is met or we run out of headroom.
const LIGHTNESS_STEP: f32 = 0.02;
const MAX_LIGHTNESS: f32 = 0.95;

fn default_color_for(login: &str) -> &'static str {
    let chars: Vec<char> = login.chars().collect();
    if chars.is_empty() {
        return DEFAULT_COLORS[0];
    }
    // Matches Twitch: (first char code + last char code) % palette length.
    let n = chars[0] as usize + chars[chars.len() - 1] as usize;
    DEFAULT_COLORS[n % DEFAULT_COLORS.len()]
}

fn hex_to_rgb(hex: &str) -> Option<(f32, f32, f32)> {
    let h = hex.trim().trim_start_matches('#');
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()?;
    let g = u8::from_str_radix(&h[2..4], 16).ok()?;
    let b = u8::from_str_radix(&h[4..6], 16).ok()?;
    Some((r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0))
}

fn rgb_to_hsl(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f32::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if max == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    (h, s, l)
}

fn hue_to_rgb(p: f32, q: f32, mut t: f32) -> f32 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 0.5 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

fn hsl_to_hex(h: f32, s: f32, l: f32) -> String {
    let (r, g, b) = if s.abs() < f32::EPSILON {
        (l, l, l)
    } else {
        let q = if l < 0.5 {
            l * (1.0 + s)
        } else {
            l + s - l * s
        };
        let p = 2.0 * l - q;
        (
            hue_to_rgb(p, q, h + 1.0 / 3.0),
            hue_to_rgb(p, q, h),
            hue_to_rgb(p, q, h - 1.0 / 3.0),
        )
    };
    format!(
        "#{:02X}{:02X}{:02X}",
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8
    )
}

/// Resolve the color to actually render for a chatter.
///
/// `tag_color` is the raw `color` IRC tag, which is frequently empty.
pub fn resolve(tag_color: Option<&str>, login: &str) -> String {
    let hex = match tag_color {
        Some(c) if hex_to_rgb(c).is_some() => c.to_string(),
        _ => default_color_for(login).to_string(),
    };

    let Some((r, g, b)) = hex_to_rgb(&hex) else {
        return hex;
    };

    if contrast_with_background(r, g, b) >= MIN_CONTRAST {
        return hex.to_ascii_uppercase();
    }

    // Raise lightness, keeping hue and saturation, until the text is legible.
    // HSL lightness is not perceptual -- pure blue sits at L=0.5 but is far
    // darker to the eye than pure yellow -- so we drive the loop off measured
    // contrast rather than off a fixed lightness floor.
    let (h, s, l) = rgb_to_hsl(r, g, b);
    let mut lightness = l;
    while lightness < MAX_LIGHTNESS {
        lightness = (lightness + LIGHTNESS_STEP).min(MAX_LIGHTNESS);
        let candidate = hsl_to_hex(h, s, lightness);
        if let Some((cr, cg, cb)) = hex_to_rgb(&candidate) {
            if contrast_with_background(cr, cg, cb) >= MIN_CONTRAST {
                return candidate;
            }
        }
    }

    hsl_to_hex(h, s, MAX_LIGHTNESS)
}

/// WCAG relative luminance.
fn relative_luminance(r: f32, g: f32, b: f32) -> f32 {
    fn linearize(channel: f32) -> f32 {
        if channel <= 0.03928 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    }
    0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)
}

fn contrast_with_background(r: f32, g: f32, b: f32) -> f32 {
    let foreground = relative_luminance(r, g, b);
    let background = relative_luminance(BACKGROUND.0, BACKGROUND.1, BACKGROUND.2);
    let (lighter, darker) = if foreground > background {
        (foreground, background)
    } else {
        (background, foreground)
    };
    (lighter + 0.05) / (darker + 0.05)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_color_is_stable_per_login() {
        let a = resolve(None, "someuser");
        let b = resolve(None, "someuser");
        assert_eq!(a, b);
        assert!(a.starts_with('#') && a.len() == 7);
    }

    #[test]
    fn different_logins_can_get_different_colors() {
        // Not a guarantee for any specific pair, but the palette must actually vary.
        let colors: std::collections::HashSet<String> = [
            "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
        ]
        .iter()
        .map(|n| resolve(None, n))
        .collect();
        assert!(colors.len() > 1, "palette should not collapse to one color");
    }

    #[test]
    fn explicit_color_is_respected_when_bright_enough() {
        assert_eq!(resolve(Some("#1E90FF"), "user"), "#1E90FF");
    }

    #[test]
    fn dark_colors_are_lifted_to_a_readable_contrast() {
        // Pure blue is the classic unreadable Twitch color on a dark background.
        let lifted = resolve(Some("#0000FF"), "user");
        assert_ne!(lifted, "#0000FF");
        let (r, g, b) = hex_to_rgb(&lifted).unwrap();
        let ratio = contrast_with_background(r, g, b);
        assert!(
            ratio >= MIN_CONTRAST,
            "expected >= {MIN_CONTRAST} contrast, got {ratio} ({lifted})"
        );
    }

    #[test]
    fn every_palette_color_ends_up_readable() {
        for name in [
            "a", "bb", "ccc", "dddd", "e", "ff", "ggg", "h", "ii", "jjj", "k", "ll", "m", "nn", "o",
        ] {
            let color = resolve(None, name);
            let (r, g, b) = hex_to_rgb(&color).unwrap();
            let ratio = contrast_with_background(r, g, b);
            assert!(
                ratio >= MIN_CONTRAST,
                "{name} -> {color} has contrast {ratio}"
            );
        }
    }

    #[test]
    fn already_readable_colors_are_left_untouched() {
        // A light color needs no adjustment at all.
        assert_eq!(resolve(Some("#FFFFFF"), "user"), "#FFFFFF");
    }

    #[test]
    fn hue_survives_the_lightness_lift() {
        let lifted = resolve(Some("#0000FF"), "user");
        let (r, g, b) = hex_to_rgb(&lifted).unwrap();
        assert!(b > r && b > g, "blue should stay blue, got {lifted}");
    }

    #[test]
    fn malformed_color_tags_fall_back_to_the_palette() {
        assert!(resolve(Some("notacolor"), "user").starts_with('#'));
        assert!(resolve(Some(""), "user").starts_with('#'));
    }

    #[test]
    fn empty_login_does_not_panic() {
        assert!(resolve(None, "").starts_with('#'));
    }
}
