import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONTEXT_OPTIONS = Object.freeze({
  maxLineChars: 42,
  maxOutputLines: 2,
  preferredOutputLines: 1,
  maxInternalGapSeconds: 1.5,
  maxCueSeconds: 12,
  minCueSeconds: 0.8,
  targetReadingChars: 52,
});

function cleanText(value) {
  return String(value).replace(/\s+([,.!?;:。，、！？；：])/gu, "$1").replace(/\s+/gu, " ").trim();
}

function readingLength(value) {
  return [...String(value).replace(/\s/gu, "")].length;
}

function parseFps(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/u.exec(text);
  if (!match) throw new Error(`Invalid fps: ${value}`);
  const numerator = Number(match[1]);
  const denominator = match[2] ? Number(match[2]) : 1;
  const fps = numerator / denominator;
  if (!(fps > 0)) throw new Error(`Invalid fps: ${value}`);
  return fps;
}

function sentenceEnd(text) {
  return /[.!?。！？][)\]}”’'"]*$/u.test(String(text).trim());
}

export function contextBoundaryPenalty(leftText, rightText) {
  const left = String(leftText).trim().split(/\s+/u).at(-1) ?? "";
  const right = String(rightText).trim().split(/\s+/u)[0] ?? "";
  let penalty = 0;
  const protectedTechnicalPairs = [
    [/^서브$/u, /^그래프/u],
    [/^Stable$/u, /^Diffusion/u],
    [/^Z$/u, /^image$/u],
    [/^image$/u, /^Turbo/u],
    [/^Reference$/u, /^to$/u],
    [/^to$/u, /^Video/u],
    [/^Dual$/u, /^CFG$/u],
    [/^CFG$/u, /^Guider/u],
    [/^manual$/u, /^sigma/u],
    [/^Gemini$/u, /^Omni/u],
    [/^(?:LTX|Wan)$/u, /^\d+(?:\.\d+)+/u],
    [/^finger$/u, /^inpainting$/u],
    [/^inpainting$/u, /^workflow/u],
    [/^모션$/u, /^그래픽/u],
    [/^유튜브$/u, /^채널/u],
    [/^태세$/u, /^전환/u],
    [/^첫$/u, /^번째/u],
    [/^영상$/u, /^주제/u],
    [/^(?:한|두|세|네)$/u, /^(?:개|가지|명|번|분)/u],
    [/^레퍼런스$/u, /^이미지/u],
    [/^캐릭터$/u, /^시트/u],
    [/^게$/u, /^아니라/u],
    [/^수$/u, /^있는/u],
    [/^먼저$/u, /^(?:도와|확인|알려|만들)/u],
    [/^조금$/u, /^더$/u],
    [/^후원해$/u, /^주/u],
    [/^걸어$/u, /^보/u],
    [/^자영업자$/u, /^사장/u],
    [/^훨씬$/u, /^더$/u],
    [/^것$/u, /^(?:중|같)/u],
    [/^대화$/u, /^형식/u],
    [/^영상$/u, /^(?:제작|관련|후원|같은)/u],
    [/^햄폭격$/u, /^부대찌개/u],
    [/^컷$/u, /^편집/u],
    [/^배경$/u, /^같/u],
    [/^바꿔$/u, /^말하면/u],
    [/^내용물만$/u, /^바뀐다/u],
    [/^드래그$/u, /^앤$/u],
    [/^앤$/u, /^드롭/u],
    [/^그$/u, /^다음/u],
    [/^AI$/u, /^(?:광고|기술)/u],
    [/^MiniMax$/u, /^모델/u],
    [/^총$/u, /^(?:한|두|세|네|\d)/u],
    [/^(?:벌|얻어낼|만들)$/u, /^(?:수|거)/u],
    [/^번$/u, /^쭉$/u],
    [/^처음$/u, /^(?:시작|하시는)/u],
    [/^(?:보통|최소)$/u, /^\d/u],
    [/^(?:좀|조금)$/u, /^더$/u],
    [/^글씨$/u, /^같/u],
    [/[가-힣]+$/u, /^수$/u],
    [/^수$/u, /^있/u],
    [/^걸$/u, /^[가-힣]+/u],
    [/^(?:Codex나|Claude나|GPT나)$/u, /^(?:Codex|Claude|GPT)/u],
    [/^Premiere$/u, /^Pro$/u],
    [/^이끌어$/u, /^나가/u],
    [/^시작$/u, /^이미지/u],
    [/^좀$/u, /^[가-힣]+/u],
    [/^빼$/u, /^버/u],
    [/^몇$/u, /^개/u],
    [/^메모장$/u, /^같/u],
    [/^영상$/u, /^만들/u],
    [/^워크플로우$/u, /^순서/u],
    [/^하나$/u, /^만들/u],
    [/^울트라$/u, /^요금제/u],
    [/^불러온$/u, /^다음/u],
    [/^판매$/u, /^중/u],
    [/^그냥$/u, /^(?:제가|사용|빼)/u],
    [/^오늘$/u, /^영상/u],
    [/^공유해$/u, /^드릴/u],
    [/^만들어야$/u, /^나/u],
    [/^굉장히$/u, /^유용/u],
    [/^적극$/u, /^사용/u],
    [/^(?:Codex|Claude|Pollo|MiniMax|Seedance|Pro)$/u, /^같/u],
    [/^일반인분들$/u, /^입장/u],
    [/^부대찌개$/u, /^광고/u],
    [/^좋아하다$/u, /^보니까/u],
    [/^영상$/u, /^하단/u],
    [/^상당히$/u, /^구체적/u],
    [/^Premiere$/u, /^Pro/u],
    [/^안$/u, /^[가-힣]+/u],
    [/^조금$/u, /^[가-힣]+/u],
    [/^해$/u, /^놓/u],
    [/^다$/u, /^똑같/u],
    [/^해드릴$/u, /^건데/u],
    [/^작업$/u, /^방식/u],
    [/^원$/u, /^정도/u],
    [/^싸$/u, /^보이/u],
    [/^여러$/u, /^번/u],
    [/^모델$/u, /^같/u],
    [/^안녕하세요,$/u, /^Deno/u],
    [/^광고$/u, /^영상/u],
    [/^직접$/u, /^프롬프트/u],
    [/^사용해야$/u, /^된/u],
    [/^(?:AI|스킬)$/u, /^같/u],
    [/^몇$/u, /^번/u],
    [/^영상$/u, /^하단/u],
    [/^편집$/u, /^과정/u],
    [/^영상$/u, /^두$/u],
    [/^(?:3만|10만|100만)$/u, /^원/u],
    [/^Pollo$/u, /^AI/u],
    [/^직접$/u, /^(?:불러온|만드시는)/u],
    [/^내용$/u, /^정리/u],
    [/^스킬$/u, /^작업/u],
    [/^쓰여$/u, /^있는/u],
    [/^이런$/u, /^AI/u],
    [/^마음을$/u, /^먹은/u],
    [/^제작을$/u, /^위한/u],
    [/^영상을$/u, /^(?:만들|본격)/u],
    [/^방향으로$/u, /^이끌어/u],
    [/^가정을$/u, /^하더라도/u],
    [/^어떤$/u, /^식으로/u],
    [/^그런$/u, /^워크플로우/u],
    [/^가지고$/u, /^와서/u],
    [/^이렇게$/u, /^MiniMax/u],
    [/^드롭한$/u, /^다음에/u],
    [/^먹은$/u, /^것/u],
    [/^나가는$/u, /^기술/u],
    [/^이$/u, /^스킬/u],
    [/^혼자서$/u, /^생각/u],
    [/^소개해$/u, /^드려도/u],
    [/^드릴$/u, /^거거든요/u],
    [/^다시$/u, /^얘기/u],
    [/^개$/u, /^생성/u],
    [/^스킬이란$/u, /^것은/u],
    [/^번$/u, /^트라이/u],
    [/^다른$/u, /^공간/u],
    [/^완전히$/u, /^처음/u],
    [/^서툴러$/u, /^가지고/u],
  ];
  if (protectedTechnicalPairs.some(([leftPattern, rightPattern]) => leftPattern.test(left) && rightPattern.test(right))) {
    penalty += 5000;
  }
  if (/^(?:그런데|하지만|그래서|그리고|그러니까|어)$/u.test(left)) penalty += 5000;
  const concessiveDoEnding = /(?:아|어|해|않아)도$/u.test(left);
  if (
    !concessiveDoEnding &&
    /(?:은|는|이|가|도|의|을|를|와|과|에|로|으로|한테|에게|에서|부터|까지|보다|처럼|지|실|할|될|한|된|하는|있는|없는)$/u.test(left)
  ) penalty += 2500;
  if (concessiveDoEnding) penalty += 1500;
  if (/(?:고|면|서|게)$/u.test(left)) penalty += 1500;
  if (/^(?:않|아니라|있|없|되|돼|해서|하면|텐데|때문에|이미지|시트|가지|보이고)$/u.test(right)) penalty += 5000;
  if (/(?:에|의|을|를|은|는|와|과|로|으로|한테|에게|에서|부터|까지|보다|처럼)$/u.test(left)) penalty += 1200;
  if (/(?:복잡한|다양한|새로운|특정|원하는|필요한|중요한|좋은|많은|같은|없는|있는|하는|되는|된|인|적인|할|될|볼|갈|줄|빠른|어떤|모든|이런|그런|첫)$/u.test(left)) penalty += 1300;
  if (/(?:방향성에|대상에|경우에|부분에|것에|입장인|위한)$/u.test(left)) penalty += 1800;
  if (/^(?:대해서|위해서|때문에|이라는|라고|하는|하고|인데|지만|거나|면서|수가|수도|것을|것이|것도|구조로|경우도|부분을|계신|다루는|만들어서|사용하는|그래프|전환|번째)$/u.test(right)) penalty += 1800;
  if (/^(?:잘|한번)$/u.test(left)) penalty += 1500;
  if (/(?:해서|하며|하면서|지만|는데|이고|하고|라서|니까|텐데|대해서|위해서|때문에|통해서|골라서|말해서|계속해서|사용해서|시작해서|등장하면서|기울이고|개발하고|제시하고)[,.]?$/u.test(left)) penalty += 900;
  if (/^(?:한번|다시)$/u.test(right) && /(?:대해서|해서|말해서)$/u.test(left)) penalty += 1300;
  if (/[,;:]$/u.test(left)) penalty -= 320;
  return penalty;
}

function bestLines(text, maxLineChars, preferredOutputLines = 1, cardTexts = null) {
  const units = Array.isArray(cardTexts)
    ? cardTexts.map((value) => cleanText(value)).filter(Boolean)
    : text.split(/\s+/u).filter(Boolean);
  if ([...text].length <= maxLineChars && (preferredOutputLines < 2 || units.length < 2)) return [text];
  let best = null;
  for (let index = 1; index < units.length; index += 1) {
    const left = cleanText(units.slice(0, index).join(" "));
    const right = cleanText(units.slice(index).join(" "));
    if ([...left].length > maxLineChars || [...right].length > maxLineChars) continue;
    const score = Math.abs([...left].length - [...right].length) + contextBoundaryPenalty(left, right) / 50;
    if (!best || score < best.score) best = {score, lines: [left, right]};
  }
  return best?.lines ?? null;
}

function frameToSrt(frame, fps) {
  const totalMs = Math.round(frame * 1000 / fps);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function validateCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) throw new Error("MFA alignment has no display_cards");
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (card.index !== index + 1) throw new Error(`display_cards[${index}] index is not contiguous`);
    for (const key of ["start_frame", "end_frame_exclusive"]) {
      if (!Number.isInteger(card[key])) throw new Error(`display_cards[${index}].${key} must be an integer`);
    }
    if (card.end_frame_exclusive <= card.start_frame) throw new Error(`display_cards[${index}] has non-positive duration`);
    if (!cleanText(card.text)) throw new Error(`display_cards[${index}] has empty text`);
  }
}

export function regroupMfaCaptionContext(alignment, overrides = {}) {
  const options = {...DEFAULT_CONTEXT_OPTIONS, ...overrides};
  const fps = parseFps(overrides.fps ?? alignment?.timing_policy?.fps);
  const cards = alignment?.display_cards;
  validateCards(cards);
  const maxGapFrames = Math.round(options.maxInternalGapSeconds * fps);
  const maxCueFrames = Math.round(options.maxCueSeconds * fps);
  const minCueFrames = Math.ceil(options.minCueSeconds * fps);

  const blocks = [];
  let blockStart = 0;
  for (let index = 0; index < cards.length; index += 1) {
    const next = cards[index + 1];
    const gap = next ? next.start_frame - cards[index].end_frame_exclusive : Infinity;
    const nextStartsAcknowledgement = Boolean(
      next && /^(?:네|예|어|아|음)[,.]?$/u.test(next.text),
    );
    if (sentenceEnd(cards[index].text) || gap > maxGapFrames || nextStartsAcknowledgement || !next) {
      blocks.push([blockStart, index]);
      blockStart = index + 1;
    }
  }

  let groups = [];
  for (const [start, end] of blocks) {
    const dp = new Array(end + 2).fill(null);
    dp[end + 1] = {cost: 0, groups: []};
    for (let position = end; position >= start; position -= 1) {
      let text = "";
      let largestGapFrames = 0;
      for (let candidateEnd = position; candidateEnd <= end; candidateEnd += 1) {
        if (candidateEnd > position) {
          const gap = cards[candidateEnd].start_frame - cards[candidateEnd - 1].end_frame_exclusive;
          largestGapFrames = Math.max(largestGapFrames, gap);
          if (gap > maxGapFrames) break;
        }
        text = cleanText(text ? `${text} ${cards[candidateEnd].text}` : cards[candidateEnd].text);
        const durationFrames = cards[candidateEnd].end_frame_exclusive - cards[position].start_frame;
        if (durationFrames > maxCueFrames) break;
        const lines = bestLines(
          text,
          options.maxLineChars,
          options.preferredOutputLines,
          cards.slice(position, candidateEnd + 1).map((card) => card.text),
        );
        if (!lines || lines.length > options.maxOutputLines) continue;
        const nextPlan = dp[candidateEnd + 1];
        if (!nextPlan) continue;
        const chars = readingLength(text);
        let cost = 100 + Math.abs(chars - options.targetReadingChars) * 0.8;
        if (chars < 28 && candidateEnd < end) cost += 320;
        if (lines.length < options.preferredOutputLines && candidateEnd < end) cost += 600;
        if (durationFrames > fps * 9) cost += (durationFrames - fps * 9) * 0.3;
        if (candidateEnd < end) cost += contextBoundaryPenalty(cards[candidateEnd].text, cards[candidateEnd + 1].text);
        const candidate = {
          cost: cost + nextPlan.cost,
          groups: [{start: position, end: candidateEnd, text, lines, durationFrames, largestGapFrames}, ...nextPlan.groups],
        };
        if (!dp[position] || candidate.cost < dp[position].cost) dp[position] = candidate;
      }
      if (!dp[position]) throw new Error(`No readable grouping starts at display card ${position + 1}`);
    }
    groups.push(...dp[start].groups);
  }

  for (let index = 0; index + 1 < groups.length; index += 1) {
    const left = groups[index];
    const right = groups[index + 1];
    const text = cleanText(`${left.text} ${right.text}`);
    const lines = bestLines(
      text,
      options.maxLineChars,
      options.preferredOutputLines,
      cards.slice(left.start, right.end + 1).map((card) => card.text),
    );
    const durationFrames = cards[right.end].end_frame_exclusive - cards[left.start].start_frame;
    const gapFrames = cards[right.start].start_frame - cards[left.end].end_frame_exclusive;
    if (
      (left.durationFrames < minCueFrames || right.durationFrames < minCueFrames) &&
      durationFrames <= maxCueFrames &&
      gapFrames <= maxGapFrames &&
      lines &&
      contextBoundaryPenalty(cards[left.end].text, cards[right.start].text) < 1000 &&
      !(
        sentenceEnd(cards[left.end].text) &&
        /^(?:네|예|어|아|음)[,.]?$/u.test(cards[right.start].text)
      )
    ) {
      groups.splice(index, 2, {
        start: left.start,
        end: right.end,
        text,
        lines,
        durationFrames,
        largestGapFrames: Math.max(left.largestGapFrames, right.largestGapFrames, gapFrames),
      });
      index -= 1;
    }
  }

  const consumed = groups.flatMap((group) =>
    Array.from({length: group.end - group.start + 1}, (_, offset) => group.start + offset + 1)
  );
  const expected = Array.from({length: cards.length}, (_, index) => index + 1);
  if (JSON.stringify(consumed) !== JSON.stringify(expected)) throw new Error("display_cards were not consumed exactly once");
  const sourceText = cleanText(cards.map((card) => card.text).join(" "));
  const groupedText = cleanText(groups.map((group) => group.text).join(" "));
  if (sourceText !== groupedText) throw new Error("Context regrouping changed caption text or order");

  const dependentBoundaries = [];
  const badBoundaries = [];
  for (let index = 0; index + 1 < groups.length; index += 1) {
    const left = cards[groups[index].end].text;
    const right = cards[groups[index + 1].start].text;
    const penalty = contextBoundaryPenalty(left, right);
    const evidence = {afterCue: index + 1, left, right, penalty};
    if (penalty >= 1000) dependentBoundaries.push(evidence);
    if (penalty >= 4000) badBoundaries.push(evidence);
  }
  if (badBoundaries.length > 0) {
    throw new Error(
      `Context regrouping left ${badBoundaries.length} dependent boundaries: ${JSON.stringify(badBoundaries)}`,
    );
  }

  const cues = groups.map((group, index) => ({
    index: index + 1,
    text: group.text,
    textLines: group.lines,
    displayCardStart: group.start + 1,
    displayCardEnd: group.end + 1,
    startFrame: cards[group.start].start_frame,
    endFrameExclusive: cards[group.end].end_frame_exclusive,
    durationFrames: group.durationFrames,
    largestGapFrames: group.largestGapFrames,
  }));
  const srt = cues.map((cue) => [
    String(cue.index),
    `${frameToSrt(cue.startFrame, fps)} --> ${frameToSrt(cue.endFrameExclusive, fps)}`,
    ...cue.textLines,
  ].join("\r\n")).join("\r\n\r\n") + "\r\n";

  return {
    srt: `\uFEFF${srt}`,
    report: {
      schemaVersion: 1,
      operation: "regroup-mfa-caption-context",
      reviewStatus: "automated-candidate",
      directSemanticReviewRequired: true,
      fps,
      options,
      displayCardCount: cards.length,
      cueCount: cues.length,
      oneLineCueCount: cues.filter((cue) => cue.textLines.length === 1).length,
      twoLineCueCount: cues.filter((cue) => cue.textLines.length === 2).length,
      textAndOrderPreserved: true,
      badBoundaryCount: badBoundaries.length,
      dependentBoundaryCount: dependentBoundaries.length,
      dependentBoundaries,
      maxCueDurationFrames: Math.max(...cues.map((cue) => cue.durationFrames)),
      maxInternalGapFrames: Math.max(...cues.map((cue) => cue.largestGapFrames)),
      cues,
    },
  };
}

function parseArgs(argv) {
  const options = {alignment: "", out: "", report: "", fps: null, maxCueSeconds: null, allowOverwrite: false};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--allow-overwrite") options.allowOverwrite = true;
    else if (["--alignment", "--out", "--report", "--fps", "--max-cue-seconds"].includes(value)) {
      if (index + 1 >= argv.length) throw new Error(`${value} requires a value`);
      const key = value.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
      options[key] = argv[++index];
    } else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function usage() {
  return "node scripts/regroup-mfa-caption-context.mjs --alignment <mfa-core-alignment.json> --out <final.srt> --report <report.json> [--fps 30] [--max-cue-seconds 12]";
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(usage());
  if (!options.alignment || !options.out || !options.report) throw new Error(usage());
  const outPath = path.resolve(options.out);
  const reportPath = path.resolve(options.report);
  if (!options.allowOverwrite && (fs.existsSync(outPath) || fs.existsSync(reportPath))) {
    throw new Error("Refusing to overwrite existing context-regroup output");
  }
  const alignment = JSON.parse(fs.readFileSync(path.resolve(options.alignment), "utf8"));
  const result = regroupMfaCaptionContext(alignment, {
    ...(options.fps ? {fps: options.fps} : {}),
    ...(options.maxCueSeconds ? {maxCueSeconds: Number(options.maxCueSeconds)} : {}),
  });
  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.mkdirSync(path.dirname(reportPath), {recursive: true});
  fs.writeFileSync(outPath, result.srt, "utf8");
  fs.writeFileSync(reportPath, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({outPath, reportPath, cueCount: result.report.cueCount, displayCardCount: result.report.displayCardCount}, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) runCli().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
