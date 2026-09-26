export const motionFonts = {
  'clother-black': {family: 'DenoMotionClotherBlack', name: 'Clother Black', weight: 900, local: 'Clother Black', role: 'bold editorial title'},
  'parabolica-black': {family: 'DenoMotionParabolicaBlack', name: 'Parabolica Black', weight: 900, local: 'Parabolica Black', role: 'steps, lists and large values'},
  'parabolica-text-bold': {family: 'DenoMotionParabolicaTextBold', name: 'Parabolica Text Bold', weight: 700, local: 'Parabolica Text Bold', role: 'compact cards and callouts'},
  'barlow-condensed-extrabold': {family: 'DenoMotionBarlowCondensed', name: 'Barlow Condensed ExtraBold', weight: 800, file: 'fonts/motion/barlowcondensed/BarlowCondensed-ExtraBold.ttf', role: 'tall condensed display'},
  'archivo-black': {family: 'DenoMotionArchivoBlack', name: 'Archivo Black', weight: 400, file: 'fonts/motion/archivoblack/ArchivoBlack-Regular.ttf', role: 'wide heavy display'},
  'space-grotesk-medium': {family: 'DenoMotionSpaceGrotesk', name: 'Space Grotesk Medium', weight: 500, file: 'fonts/motion/spacegrotesk/SpaceGrotesk[wght].ttf', role: 'technical counters before emphasis'},
  'space-grotesk-bold': {family: 'DenoMotionSpaceGrotesk', name: 'Space Grotesk Bold', weight: 700, file: 'fonts/motion/spacegrotesk/SpaceGrotesk[wght].ttf', role: 'technical labels and numerals'},
  // Korean faces: OFL, copied from the local install (provenance and sha256 in docs/agent/workflows/motion-typography.md).
  // Every Hangul syllable and all compatibility jamo are present, so a jamo-by-jamo typing reveal never falls back.
  // `extra`: single characters outside those ranges, each looked up in this file's (3,10) cmap before being allowed —
  // ₩ (U+20A9, the Korean-Windows path separator) and 整理 (a mixed-language example), verified 2026-09-18.
  'noto-sans-kr-bold': {family: 'DenoMotionNotoSansKR', name: 'Noto Sans KR Bold', weight: 700, file: 'fonts/motion/notosanskr/NotoSansKR[wght].ttf', role: 'Korean typed instructions and labels', script: 'hangul', extra: '₩整理'},
  'noto-sans-kr-black': {family: 'DenoMotionNotoSansKR', name: 'Noto Sans KR Black', weight: 900, file: 'fonts/motion/notosanskr/NotoSansKR[wght].ttf', role: 'Korean display', script: 'hangul', extra: '₩整理'},
} as const;

export type MotionFontId = keyof typeof motionFonts;
export type MotionFont = (typeof motionFonts)[MotionFontId];

export function selectMotionFont(id: MotionFontId): MotionFont {
  if (!Object.hasOwn(motionFonts, id)) throw new Error(`Unregistered motion font: ${id}. Select and prepare a licensed face; system fallback is prohibited.`);
  return motionFonts[id];
}

// Copy is checked against the face it will be drawn with: Latin faces take English copy only; faces registered with
// `script: 'hangul'` also take Hangul syllables and compatibility jamo (their cmap was verified in full).
const LATIN_COPY = /^[\x20-\x7e…–—‘’“”·×]*$/u;
const HANGUL_COPY = /^[\x20-\x7e…–—‘’“”·×ㄱ-ㆎ가-힣]*$/u;
export function validateMotionText(lines: string[], id?: MotionFontId) {
  const face = id === undefined ? null : motionFonts[id];
  const hangul = face !== null && 'script' in face && face.script === 'hangul';
  const extra = face !== null && 'extra' in face ? [...face.extra] : [];
  for (const text of lines) {
    const rest = [...text].filter((ch) => !extra.includes(ch)).join('');
    if (!(hangul ? HANGUL_COPY : LATIN_COPY).test(rest)) {
      throw new Error(`Copy "${text}" has characters ${face ? face.name : 'the default pool'} does not cover. Select and verify a face for this script instead of falling back to a system font.`);
    }
  }
}
