import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const options = {
    transcript: "",
    out: "",
    maxGapSeconds: 3.5,
    maxUnitSeconds: 18,
    maxUnitChars: 150,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--transcript") options.transcript = argv[++index];
    else if (value === "--out") options.out = argv[++index];
    else if (value === "--max-gap") options.maxGapSeconds = Number(argv[++index]);
    else if (value === "--max-unit-seconds") options.maxUnitSeconds = Number(argv[++index]);
    else if (value === "--max-unit-chars") options.maxUnitChars = Number(argv[++index]);
    else if (value === "--help" || value === "-h") options.help = true;
  }
  return options;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/build-premiere-transcript-brief.mjs --transcript <json> --out <json>",
    "",
    "Builds transcript units for semantic editing review.",
  ].join("\n");
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a, b) {
  const aSet = new Set(normalizeText(a).split(" ").filter(Boolean));
  const bSet = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let intersection = 0;
  for (const value of aSet) {
    if (bSet.has(value)) intersection += 1;
  }
  return intersection / (aSet.size + bSet.size - intersection);
}

function buildUnits(groups, options) {
  const units = [];
  let current = null;

  function flush() {
    if (!current) return;
    current.text = current.parts.join(" ").replace(/\s+/g, " ").trim();
    current.durationSeconds = round(current.endSeconds - current.startSeconds);
    current.groupCount = current.groupIndexes.length;
    delete current.parts;
    units.push(current);
    current = null;
  }

  for (const group of groups) {
    if (!group.text || group.text === "알 수 없음") continue;
    if (!Number.isFinite(group.startSeconds) || !Number.isFinite(group.endSeconds)) continue;
    const shouldStart =
      !current ||
      group.startSeconds - current.endSeconds > options.maxGapSeconds ||
      group.endSeconds - current.startSeconds > options.maxUnitSeconds ||
      current.parts.join(" ").length + group.text.length > options.maxUnitChars;

    if (shouldStart) {
      flush();
      current = {
        index: units.length,
        startSeconds: round(group.startSeconds),
        endSeconds: round(group.endSeconds),
        groupIndexes: [group.index],
        parts: [group.text],
      };
    } else {
      current.endSeconds = round(group.endSeconds);
      current.groupIndexes.push(group.index);
      current.parts.push(group.text);
    }
  }
  flush();
  return units;
}

function annotateUnits(units) {
  const cueWords = {
    wait: ["잠깐", "기다", "다녀오", "재시작", "완료", "생성", "멈추면", "확인", "돌아오"],
    restart: ["재시작", "다시", "불러오", "새로"],
    filler: ["어", "음", "네", "자", "그", "그다음", "그러니까"],
  };

  return units.map((unit, index) => {
    const prev = units[index - 1];
    const next = units[index + 1];
    const prevSimilarity = prev ? jaccard(prev.text, unit.text) : 0;
    const nextSimilarity = next ? jaccard(unit.text, next.text) : 0;
    const lower = normalizeText(unit.text);
    const tags = [];
    for (const [tag, words] of Object.entries(cueWords)) {
      if (words.some((word) => lower.includes(word))) tags.push(tag);
    }
    if (nextSimilarity >= 0.35) tags.push("similar_to_next");
    if (prevSimilarity >= 0.35) tags.push("similar_to_prev");
    return {
      ...unit,
      prevSimilarity: round(prevSimilarity, 3),
      nextSimilarity: round(nextSimilarity, 3),
      tags,
    };
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.transcript || !options.out) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }

  const transcript = JSON.parse(fs.readFileSync(options.transcript, "utf8"));
  const groups = transcript.groups
    .filter((group) => group.text && group.text !== "알 수 없음")
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const units = annotateUnits(buildUnits(groups, options));
  const payload = {
    transcript: path.resolve(options.transcript),
    options,
    groupCount: groups.length,
    unitCount: units.length,
    units,
  };

  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ out: path.resolve(options.out), units: units.length }, null, 2));
}

main();
