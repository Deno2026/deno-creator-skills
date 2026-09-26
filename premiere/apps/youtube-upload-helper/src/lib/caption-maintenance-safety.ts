import type { YouTubeCaptionSnapshot } from "./caption-maintenance-store";

export const WRITABLE_CAPTION_LANGUAGES = ["ko", "en"] as const;

export type WritableCaptionLanguage = (typeof WRITABLE_CAPTION_LANGUAGES)[number];

export type CaptionWritePrecondition = {
  language: WritableCaptionLanguage;
  expectedAction: "update" | "insert";
  expectedCaptionId?: string;
  expectedLastUpdated?: string;
};

export type CanonicalSrtDifference = {
  cue: number;
  issue: "missing_cue" | "number" | "timing" | "text";
  expected?: string | number;
  actual?: string | number;
};

export type CanonicalSrtComparison = {
  ok: boolean;
  expectedCueCount: number;
  actualCueCount: number;
  differences: CanonicalSrtDifference[];
};

export function isWritableCaptionLanguage(value: string): value is WritableCaptionLanguage {
  return (WRITABLE_CAPTION_LANGUAGES as readonly string[]).includes(value.toLowerCase());
}

export function requireWritableCaptionLanguage(value: string): WritableCaptionLanguage {
  const normalized = value.trim().toLowerCase();
  if (!isWritableCaptionLanguage(normalized)) {
    throw new Error(
      `UNSUPPORTED_MANUAL_CAPTION_LANGUAGE: ${value || "(empty)"}. 수동 SRT 쓰기는 ko와 en만 허용됩니다.`,
    );
  }
  return normalized;
}

export function manualTracksForLanguage(
  captions: YouTubeCaptionSnapshot[],
  language: string,
) {
  const normalized = language.trim().toLowerCase();
  return captions.filter(
    (caption) =>
      caption.language.toLowerCase() === normalized &&
      caption.trackKind.toUpperCase() !== "ASR",
  );
}

export function assertManualTrackPrecondition(
  captions: YouTubeCaptionSnapshot[],
  precondition: CaptionWritePrecondition,
) {
  const manual = manualTracksForLanguage(captions, precondition.language);
  if (manual.length > 1) {
    throw new Error(
      `DUPLICATE_MANUAL_TRACK: ${precondition.language} 수동 자막이 ${manual.length}개라 대상을 안전하게 특정할 수 없습니다.`,
    );
  }

  if (precondition.expectedAction === "insert") {
    if (manual.length !== 0) {
      throw new Error(
        `STALE_CAPTION_PRECONDITION: ${precondition.language} 수동 자막이 조회 뒤 새로 생겼습니다. 다시 조회해 주세요.`,
      );
    }
    return null;
  }

  const current = manual[0];
  if (!current) {
    throw new Error(
      `STALE_CAPTION_PRECONDITION: ${precondition.language} 수동 자막이 조회 뒤 사라졌습니다. 다시 조회해 주세요.`,
    );
  }
  if (!precondition.expectedCaptionId || current.id !== precondition.expectedCaptionId) {
    throw new Error(
      `STALE_CAPTION_PRECONDITION: ${precondition.language} caption ID가 조회 snapshot과 다릅니다.`,
    );
  }
  if ((current.lastUpdated ?? "") !== (precondition.expectedLastUpdated ?? "")) {
    throw new Error(
      `STALE_CAPTION_PRECONDITION: ${precondition.language} lastUpdated가 조회 snapshot과 다릅니다.`,
    );
  }
  return current;
}

export function assertLockedArtifactHash(params: {
  language: WritableCaptionLanguage;
  submittedSha256: string;
  lockedSha256: string;
}) {
  if (params.submittedSha256.toLowerCase() !== params.lockedSha256.toLowerCase()) {
    throw new Error(
      `STALE_CAPTION_REVISION: ${params.language} SRT SHA-256이 current caption source lock과 다릅니다.`,
    );
  }
}

type CanonicalCue = {
  number: number;
  timing: string;
  text: string;
};

function canonicalCues(raw: string): CanonicalCue[] {
  const normalized = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!normalized) return [];

  return normalized.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    return {
      number: Number(lines[timingIndex - 1]?.trim()),
      timing: (lines[timingIndex] ?? "").trim().replace(/\./g, ","),
      text: lines
        .slice(timingIndex + 1)
        .map((line) => line.trimEnd())
        .join("\n")
        .trim(),
    };
  });
}

export function compareCanonicalSrt(
  expectedRaw: string,
  actualRaw: string,
): CanonicalSrtComparison {
  const expected = canonicalCues(expectedRaw);
  const actual = canonicalCues(actualRaw);
  const differences: CanonicalSrtDifference[] = [];
  const max = Math.max(expected.length, actual.length);

  for (let index = 0; index < max && differences.length < 20; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (!left || !right) {
      differences.push({ cue: index + 1, issue: "missing_cue" });
      continue;
    }
    if (left.number !== right.number) {
      differences.push({
        cue: index + 1,
        issue: "number",
        expected: left.number,
        actual: right.number,
      });
    }
    if (left.timing !== right.timing) {
      differences.push({
        cue: index + 1,
        issue: "timing",
        expected: left.timing,
        actual: right.timing,
      });
    }
    if (left.text !== right.text) {
      differences.push({
        cue: index + 1,
        issue: "text",
        expected: left.text,
        actual: right.text,
      });
    }
  }

  return {
    ok: differences.length === 0 && expected.length === actual.length,
    expectedCueCount: expected.length,
    actualCueCount: actual.length,
    differences,
  };
}

function protectedCaptionSnapshot(
  captions: YouTubeCaptionSnapshot[],
  targetLanguages: WritableCaptionLanguage[],
) {
  const targets = new Set(targetLanguages);
  return captions
    .filter(
      (caption) =>
        caption.trackKind.toUpperCase() === "ASR" ||
        !targets.has(caption.language.toLowerCase() as WritableCaptionLanguage),
    )
    .map((caption) => ({ ...caption }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function compareProtectedCaptionSnapshots(
  before: YouTubeCaptionSnapshot[],
  after: YouTubeCaptionSnapshot[],
  targetLanguages: WritableCaptionLanguage[],
) {
  const beforeProtected = protectedCaptionSnapshot(before, targetLanguages);
  const afterProtected = protectedCaptionSnapshot(after, targetLanguages);
  return {
    ok: JSON.stringify(beforeProtected) === JSON.stringify(afterProtected),
    before: beforeProtected,
    after: afterProtected,
  };
}
