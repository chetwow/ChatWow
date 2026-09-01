#!/usr/bin/env python3
"""Regenerate src/lib/emoji.json from Python's Unicode database.

The emote picker searches emoji by name, so all it needs is the character and
its official Unicode name -- no dependency, no vendored third-party data, and
it re-derives cleanly on a newer Python (i.e. a newer Unicode version).

    python3 scripts/generate-emoji.py
"""

import json
import unicodedata
from pathlib import Path

# Blocks that are emoji-presentation by default, plus the strays outside them
# that people actually type (arrows, stars, the enclosed buttons).
RANGES = [
    (0x1F300, 0x1F5FF),  # Misc symbols and pictographs
    (0x1F600, 0x1F64F),  # Emoticons
    (0x1F680, 0x1F6FF),  # Transport and map
    (0x1F900, 0x1F9FF),  # Supplemental symbols and pictographs
    (0x1FA70, 0x1FAFF),  # Symbols and pictographs extended-A
    (0x2600, 0x26FF),  # Misc symbols
    (0x2700, 0x27BF),  # Dingbats
    (0x1F170, 0x1F19A),  # Enclosed letters (blood types, buttons)
    (0x1F201, 0x1F251),  # Enclosed CJK
    (0x1F7E0, 0x1F7EB),  # Colored circles and squares
    (0x231A, 0x231B),  # Watch, hourglass
    (0x23E9, 0x23FA),  # Media buttons
    (0x25FB, 0x25FE),  # Small squares
    (0x2B05, 0x2B07),  # Arrows
    (0x2B1B, 0x2B1C),  # Large squares
    (0x2B50, 0x2B50),  # Star
    (0x2B55, 0x2B55),  # Hollow circle
    (0x1F004, 0x1F004),  # Mahjong red dragon
    (0x1F0CF, 0x1F0CF),  # Joker
]

# Pieces of a sequence rather than emoji in their own right: a skin tone or a
# regional indicator on its own is not something to offer in a picker.
SKIP_PREFIXES = (
    "REGIONAL INDICATOR",
    "EMOJI MODIFIER",
    "EMOJI COMPONENT",
    "VARIATION SELECTOR",
    "TAG ",
    "COMBINING",
    "ZERO WIDTH",
)


def main() -> None:
    emoji = []
    for start, end in RANGES:
        for code in range(start, end + 1):
            char = chr(code)
            try:
                name = unicodedata.name(char)
            except ValueError:
                continue  # Unassigned in this Unicode version.
            if name.startswith(SKIP_PREFIXES):
                continue
            emoji.append({"c": char, "n": name.lower()})

    out = Path(__file__).resolve().parent.parent / "src" / "lib" / "emoji.json"
    out.write_text(json.dumps(emoji, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"wrote {len(emoji)} emoji to {out}")


if __name__ == "__main__":
    main()
