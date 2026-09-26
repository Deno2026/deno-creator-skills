export type SrtCue = {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  text: string;
};

export type ParsedSrt = {
  cues: SrtCue[];
  warnings: string[];
};

const TIMESTAMP_PATTERN =
  /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})(?:\s+.*)?$/;

function cueId(index: number) {
  return `cue-${index + 1}`;
}

function toMilliseconds(
  hours: string,
  minutes: string,
  seconds: string,
  milliseconds: string,
) {
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1_000 +
    Number(milliseconds)
  );
}

export function formatTimestamp(totalMs: number) {
  const safeMs = Math.max(0, Math.floor(totalMs));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((safeMs % 60_000) / 1_000);
  const milliseconds = safeMs % 1_000;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(seconds).padStart(2, "0"),
  ].join(":") + `,${String(milliseconds).padStart(3, "0")}`;
}

export function parseTimestamp(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);

  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds, milliseconds] = match;
  return toMilliseconds(hours, minutes, seconds, milliseconds);
}

export function parseSrt(content: string): ParsedSrt {
  const warnings: string[] = [];
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  if (!normalized) {
    return { cues: [], warnings };
  }

  const blocks = normalized.split(/\n{2,}/);
  const cues: SrtCue[] = [];

  blocks.forEach((block, blockIndex) => {
    const lines = block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean);

    if (lines.length < 2) {
      warnings.push(`${blockIndex + 1}번 자막 블록은 내용이 너무 짧아 건너뛰었습니다.`);
      return;
    }

    const timeLineIndex = lines[0].includes("-->") ? 0 : 1;
    const timeLine = lines[timeLineIndex];
    const match = timeLine.match(TIMESTAMP_PATTERN);

    if (!match) {
      warnings.push(`${blockIndex + 1}번 자막 블록은 시간 형식이 맞지 않아 건너뛰었습니다.`);
      return;
    }

    const [
      ,
      startHours,
      startMinutes,
      startSeconds,
      startMilliseconds,
      endHours,
      endMinutes,
      endSeconds,
      endMilliseconds,
    ] = match;

    const startMs = toMilliseconds(
      startHours,
      startMinutes,
      startSeconds,
      startMilliseconds,
    );
    const endMs = toMilliseconds(
      endHours,
      endMinutes,
      endSeconds,
      endMilliseconds,
    );

    cues.push({
      id: cueId(cues.length),
      index: cues.length + 1,
      startMs,
      endMs: Math.max(endMs, startMs + 100),
      text: lines.slice(timeLineIndex + 1).join("\n"),
    });
  });

  return { cues, warnings };
}

export function formatSrt(cues: SrtCue[]) {
  return cues
    .map((cue, cueIndex) => {
      const text = cue.text.trimEnd() || "...";

      return [
        String(cueIndex + 1),
        `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}`,
        text,
      ].join("\n");
    })
    .join("\n\n");
}

export function shiftSrtCues(cues: SrtCue[], deltaMs: number) {
  return cues.map((cue, cueIndex) => {
    const duration = Math.max(100, cue.endMs - cue.startMs);
    const nextStart = Math.max(0, cue.startMs + deltaMs);

    return {
      ...cue,
      id: cue.id || cueId(cueIndex),
      index: cueIndex + 1,
      startMs: nextStart,
      endMs: nextStart + duration,
    };
  });
}

export function createEmptyCue(index: number, startMs = 0, endMs = 2_000): SrtCue {
  return {
    id: cueId(index),
    index: index + 1,
    startMs,
    endMs: Math.max(endMs, startMs + 100),
    text: "",
  };
}
