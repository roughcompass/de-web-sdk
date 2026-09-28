/**
 * Hidden characters that can smuggle instructions to agents, as the
 * security-and-provenance spec lists them.
 */
const RANGES: Array<[number, number, string]> = [
  [0xe0000, 0xe007f, "Unicode tag character"],
  [0x202a, 0x202e, "bidirectional control"],
  [0x2066, 0x2069, "bidirectional control"],
  [0x200b, 0x200d, "zero-width character"],
  [0x2060, 0x2060, "zero-width character"],
  [0xfeff, 0xfeff, "zero-width character"],
];

export interface HiddenCharacter {
  line: number;
  column: number;
  codePoint: string;
  kind: string;
}

export function classify(cp: number): string | undefined {
  for (const [lo, hi, kind] of RANGES) {
    if (cp >= lo && cp <= hi) return kind;
  }
  return undefined;
}

export function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Returns the first hidden character in `text`, or undefined. */
export function findHiddenCharacter(text: string): HiddenCharacter | undefined {
  let line = 1;
  let column = 1;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const kind = classify(cp);
    if (kind) return { line, column, codePoint: formatCodePoint(cp), kind };
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return undefined;
}
