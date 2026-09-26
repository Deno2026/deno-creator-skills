// Real 두벌식 typing, reproduced key by key (2026-09-18, user request: "실제로 타이핑 하는것처럼").
//
// A string is broken into the keystrokes a person presses on a 2-set Korean keyboard, then replayed through the same
// composition automaton the OS IME uses. The screen therefore shows exactly what a typist sees, including the
// transient states — "편" + ㅈ becomes "펹" for a moment, then "편지" once ㅣ arrives (도깨비불). Latin, digits and
// punctuation are one key each.
//
// Pure and deterministic (no Date/Math.random), so renders repeat exactly. No JSX — Node can import it directly.
// The keystroke frames could drive a typing sound, but only in narration-free motion and only with sounds the user
// picked (channel-motion-profile.md "모션 효과음"); scenes the user speaks over stay silent.

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ'];
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

// Compound vowels and final clusters are two keystrokes on 두벌식.
const JUNG_SPLIT: Record<string, [string, string]> = {ㅘ: ['ㅗ', 'ㅏ'], ㅙ: ['ㅗ', 'ㅐ'], ㅚ: ['ㅗ', 'ㅣ'], ㅝ: ['ㅜ', 'ㅓ'], ㅞ: ['ㅜ', 'ㅔ'], ㅟ: ['ㅜ', 'ㅣ'], ㅢ: ['ㅡ', 'ㅣ']};
const JONG_SPLIT: Record<string, [string, string]> = {ㄳ: ['ㄱ', 'ㅅ'], ㄵ: ['ㄴ', 'ㅈ'], ㄶ: ['ㄴ', 'ㅎ'], ㄺ: ['ㄹ', 'ㄱ'], ㄻ: ['ㄹ', 'ㅁ'], ㄼ: ['ㄹ', 'ㅂ'], ㄽ: ['ㄹ', 'ㅅ'], ㄾ: ['ㄹ', 'ㅌ'], ㄿ: ['ㄹ', 'ㅍ'], ㅀ: ['ㄹ', 'ㅎ'], ㅄ: ['ㅂ', 'ㅅ']};
const JUNG_JOIN: Record<string, string> = Object.fromEntries(Object.entries(JUNG_SPLIT).map(([k, [a, b]]) => [a + b, k]));
const JONG_JOIN: Record<string, string> = Object.fromEntries(Object.entries(JONG_SPLIT).map(([k, [a, b]]) => [a + b, k]));

const isVowel = (k: string) => JUNG.includes(k);
const isConsonant = (k: string) => CHO.includes(k) || JONG.includes(k);
const canBeFinal = (k: string) => JONG.includes(k) && k !== '';

/** The keystrokes, in order, that type `text` on a 두벌식 keyboard. */
export function keystrokes(text: string): string[] {
  const keys: string[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xac00 && code <= 0xd7a3) {
      const i = code - 0xac00;
      const cho = CHO[Math.floor(i / 588)], jung = JUNG[Math.floor((i % 588) / 28)], jong = JONG[i % 28];
      keys.push(cho, ...(JUNG_SPLIT[jung] ?? [jung]));
      if (jong) keys.push(...(JONG_SPLIT[jong] ?? [jong]));
    } else keys.push(ch);
  }
  return keys;
}

type Block = {cho: string | null; jung: string | null; jong: string | null};
const compose = (b: Block): string => {
  if (b.cho && b.jung) return String.fromCodePoint(0xac00 + (CHO.indexOf(b.cho) * 21 + JUNG.indexOf(b.jung)) * 28 + JONG.indexOf(b.jong ?? ''));
  return b.cho ?? b.jung ?? '';
};

/** Screen text after each keystroke: states[i] is what shows once keys[0..i] have been pressed. */
export function typingStates(keys: string[]): string[] {
  let committed = '';
  let b: Block = {cho: null, jung: null, jong: null};
  const empty = (): Block => ({cho: null, jung: null, jong: null});
  const commit = () => { committed += compose(b); b = empty(); };
  const states: string[] = [];
  for (const k of keys) {
    if (isVowel(k)) {
      if (b.cho && !b.jung) b.jung = k;
      else if (b.jung && !b.jong && JUNG_JOIN[b.jung + k]) b.jung = JUNG_JOIN[b.jung + k];
      else if (b.cho && b.jung && b.jong) {
        // 도깨비불: the last final consonant moves on to start the next syllable.
        const split = JONG_SPLIT[b.jong];
        const moving = split ? split[1] : b.jong;
        b.jong = split ? split[0] : null;
        commit();
        b = {cho: moving, jung: k, jong: null};
      } else { commit(); b = {cho: null, jung: k, jong: null}; }
    } else if (isConsonant(k)) {
      if (!b.cho && !b.jung) b.cho = k;
      else if (b.cho && b.jung && !b.jong && canBeFinal(k)) b.jong = k;
      else if (b.cho && b.jung && b.jong && JONG_JOIN[b.jong + k]) b.jong = JONG_JOIN[b.jong + k];
      else { commit(); b.cho = k; }
    } else { commit(); committed += k; }
    states.push(committed + compose(b));
  }
  return states;
}

// Deterministic 0..1 noise per index (so renders repeat exactly).
const noise = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Frame (relative to `startFrame`) at which each keystroke lands, spread across `durationFrames` with a human rhythm:
 * uneven gaps, a short breath after a space or comma, a slightly longer one before a new word. The last keystroke lands
 * exactly on `durationFrames`, so the text is complete when the typing window ends.
 */
export function keystrokeFrames(keys: string[], durationFrames: number): number[] {
  const weights = keys.map((k, i) => {
    let w = 0.72 + noise(i, 1) * 0.56; // ±28 % around an even pace
    if (k === ' ') w *= 1.35;
    if (k === ',' || k === '.' || k === '?') w *= 1.9;
    if (k === '\n') w *= 2.6; // Shift+Enter between lines: the longest pause
    if (i > 0 && keys[i - 1] === ' ') w *= 1.15;
    return w;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return weights.map((w) => { acc += w; return (acc / total) * durationFrames; });
}

export type TypingPlan = {text: string; keys: string[]; states: string[]; frames: number[]};

/** Everything a scene or the sound synthesiser needs to type `text` over `durationFrames`. */
export function planTyping(text: string, durationFrames: number): TypingPlan {
  const keys = keystrokes(text);
  const states = typingStates(keys);
  if (states[states.length - 1] !== text) throw new Error(`typing automaton did not reproduce "${text}" (got "${states[states.length - 1]}")`);
  return {text, keys, states, frames: keystrokeFrames(keys, durationFrames)};
}

/** Screen text at `localFrame` (0 = typing starts). */
export function typedAt(plan: TypingPlan, localFrame: number): string {
  if (localFrame < plan.frames[0]) return '';
  let k = 0;
  while (k + 1 < plan.frames.length && plan.frames[k + 1] <= localFrame) k++;
  return plan.states[k];
}

/** Share of keystrokes pressed by `localFrame`, 0..1 — drives a parallel line that reveals in step. */
export function typedShare(plan: TypingPlan, localFrame: number): number {
  const done = plan.frames.filter((f) => f <= localFrame).length;
  return done / plan.frames.length;
}
