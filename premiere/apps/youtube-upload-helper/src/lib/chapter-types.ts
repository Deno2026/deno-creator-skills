/**
 * 영상 챕터 (설명란 타임스탬프 목차) 타입 + 순수 유틸.
 *
 * 서버(LLM 모듈)와 클라이언트(페이지 UI)가 함께 쓰므로 node 의존성 없는
 * 순수 함수만 둔다. LLM 호출 로직은 src/lib/llm/chapters.ts.
 */

export type ChapterEntry = {
  /** 챕터 시작 시각 (ms). */
  timeMs: number;
  /** 챕터 제목. */
  title: string;
};

/**
 * 세 가지 상세도의 챕터 후보.
 * - simple: 큰 흐름만 (3~5개)
 * - medium: 적당히 (6~10개)
 * - detailed: 세부적으로 (11~20개)
 */
export type ChapterSuggestion = {
  simple: ChapterEntry[];
  medium: ChapterEntry[];
  detailed: ChapterEntry[];
};

export type ChapterDetailLevel = "simple" | "medium" | "detailed";

/** ms → "mm:ss" 또는 "h:mm:ss" (YouTube 타임스탬프 포맷). */
export function msToTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** "mm:ss" / "m:ss" / "h:mm:ss" / "hh:mm:ss" → ms. 형식 안 맞으면 null. */
export function timestampToMs(text: string): number | null {
  const match = text.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  if (seconds > 59) return null;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * 챕터 목록 → YouTube 설명용 텍스트 블록.
 * 예:
 *   00:00 인트로
 *   01:20 모델 다운로드
 */
export function formatChapterBlock(chapters: ChapterEntry[]): string {
  return chapters
    .map((chapter) => `${msToTimestamp(chapter.timeMs)} ${chapter.title}`)
    .join("\n");
}

/** 한 줄이 "타임스탬프 + 공백 + 내용" 형태인지 (챕터 라인 감지용). */
function isChapterLine(line: string): boolean {
  return /^\s*(?:\d+:)?\d{1,2}:\d{2}\s+\S/.test(line);
}

/** 한 줄이 해시태그만 모인 라인인지 (예: "#ComfyUI #LTX23 #AI영상생성"). */
function isHashtagLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return trimmed.split(/\s+/).every((token) => token.startsWith("#"));
}

/**
 * 설명 텍스트에서 기존 챕터 블록(연속된 타임스탬프 라인 2줄 이상)을 제거.
 * 재삽입 시 중복 방지용.
 */
export function stripChapterBlock(description: string): string {
  const lines = description.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    // 연속 챕터 라인 구간 찾기
    if (isChapterLine(lines[i])) {
      let j = i;
      while (j < lines.length && isChapterLine(lines[j])) j++;
      if (j - i >= 2) {
        // 챕터 블록으로 판단 → 통째 제거. 앞뒤 빈 줄도 정리.
        while (result.length > 0 && result[result.length - 1].trim() === "") {
          result.pop();
        }
        i = j;
        while (i < lines.length && lines[i].trim() === "") i++;
        continue;
      }
    }
    result.push(lines[i]);
    i++;
  }
  return result.join("\n");
}

/**
 * 챕터 블록을 설명에 삽입.
 *
 * - 기존 챕터 블록이 있으면 먼저 제거 (중복 방지).
 * - 설명 본문 다음 줄부터 챕터를 넣되, 맨 끝에 해시태그 라인이 있으면 그 앞에 넣는다.
 *   (사용자 요청: "영상 설명 다음 라인부터 / 설명란 중간")
 */
export function insertChapterBlock(
  description: string,
  chapters: ChapterEntry[],
): string {
  const block = formatChapterBlock(chapters);
  if (!block) return description;

  const cleaned = stripChapterBlock(description).replace(/\s+$/, "");
  const lines = cleaned.split("\n");

  // 맨 끝에서부터 해시태그 라인 묶음 찾기 (그 위에 빈 줄 허용).
  let hashtagStart = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      continue;
    }
    if (isHashtagLine(line)) {
      hashtagStart = i;
      continue;
    }
    break;
  }

  if (hashtagStart < lines.length) {
    const before = lines.slice(0, hashtagStart).join("\n").replace(/\s+$/, "");
    const after = lines.slice(hashtagStart).join("\n").replace(/^\s+/, "");
    return `${before}\n\n${block}\n\n${after}`;
  }

  // 해시태그 없으면 설명 끝에.
  return `${cleaned}\n\n${block}`;
}
