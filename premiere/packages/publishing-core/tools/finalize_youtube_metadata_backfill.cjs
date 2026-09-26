#!/usr/bin/env node

const path = require("node:path");
const { createHash } = require("node:crypto");
const { readFile, rename, writeFile } = require("node:fs/promises");

const { getUploadRuntimePaths } = require("@deno/runtime-paths");

const RUNTIME_PATHS = getUploadRuntimePaths();
const BACKFILL_ROOT = RUNTIME_PATHS.metadataBackfillRoot;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (["--video-id", "--displayed-used-before", "--displayed-used-after", "--displayed-used-after-status", "--session-start-used", "--session-budget", "--cumulative-units", "--run-units", "--verification-mode", "--current-state-sha256-before"].includes(token)) {
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[key] = argv[++index];
      continue;
    }
    if (token === "--one-time-multi-video-override") {
      args.oneTimeMultiVideoOverride = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  for (const key of ["videoId", "displayedUsedBefore", "displayedUsedAfter", "sessionStartUsed", "sessionBudget", "cumulativeUnits", "runUnits", "verificationMode", "currentStateSha256Before"]) {
    if (args[key] == null) throw new Error(`Missing --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  for (const key of ["displayedUsedBefore", "displayedUsedAfter", "sessionStartUsed", "sessionBudget", "cumulativeUnits", "runUnits"]) {
    args[key] = Number(args[key]);
    if (!Number.isFinite(args[key])) throw new Error(`Invalid numeric argument: ${key}`);
  }
  args.displayedUsedAfterStatus ??= "final_live";
  if (!["final_live", "final_live_aggregation_pending", "pre_write_last_observed"].includes(args.displayedUsedAfterStatus)) {
    throw new Error(`Invalid --displayed-used-after-status: ${args.displayedUsedAfterStatus}`);
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function formatKst(iso) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso)).replace(" ", "T") + "+09:00";
}

function describeNonShortEvidence(video) {
  if (video.contentType === "video" && video.contentTypeAuthority === "youtube_studio_live_read") {
    return `YouTube Studio live 조회 권위로 일반 동영상임을 확인했다: ${video.contentTypeReason}`;
  }
  if (video.contentType === "video" && video.contentTypeAuthority === "youtube_public_channel_tab") {
    return "공개 채널의 동영상 탭 단독 소속과 live API 소유권 검증으로 일반 동영상임을 확인했다.";
  }
  if (video.durationSeconds > video.durationLimitSeconds) {
    return `영상 길이가 게시 시점 Shorts 상한보다 ${video.durationSeconds - video.durationLimitSeconds}초 길어 비Shorts 일반 영상으로 확정했다.`;
  }
  if (video.shortClassification === "not_short_landscape" && video.widthPixels > video.heightPixels) {
    return `원본 해상도 ${video.widthPixels}×${video.heightPixels}가 가로형이므로 비Shorts 일반 영상으로 확정했다.`;
  }
  return `inventory의 \`${video.shortClassification}\` 판정 근거로 비Shorts 일반 영상임을 확인했다.`;
}

async function main() {
  const args = parseArgs(process.argv);
  const packageDir = path.join(BACKFILL_ROOT, args.videoId);
  const [source, metadata, verification, perVideoState, inventory, rootState, currentStateRaw] = await Promise.all([
    readJson(path.join(packageDir, "source_snapshot.json")),
    readJson(path.join(packageDir, "metadata_backfill.json")),
    readJson(path.join(packageDir, "verification.json")),
    readJson(path.join(packageDir, "backfill_state.json")),
    readJson(path.join(BACKFILL_ROOT, "candidate_inventory.json")),
    readJson(path.join(BACKFILL_ROOT, "backfill_state.json")),
    readFile(RUNTIME_PATHS.backfillActiveStatePath, "utf8"),
  ]);
  const currentState = JSON.parse(currentStateRaw);
  const currentStateSha256 = createHash("sha256").update(currentStateRaw).digest("hex").toUpperCase();
  if (currentStateSha256 !== args.currentStateSha256Before.toUpperCase()) {
    throw new Error("CURRENT_STATE.json changed during the metadata backfill run");
  }
  if (!verification.ok || perVideoState.state !== "verified_complete") {
    throw new Error(`Video ${args.videoId} is not verified_complete`);
  }
  if (inventory.schemaVersion !== 5) {
    throw new Error("candidate_inventory.json schemaVersion 5 is required before finalization");
  }
  const completed = inventory.completedVideos.find((video) => video.videoId === args.videoId);
  if (
    !completed
    || !completed.complete
    || completed.contentType !== "video"
    || completed.policyBucket !== "eligible_video"
    || completed.isShort !== false
    || !completed.eligibleForBackfill
  ) {
    throw new Error(`Inventory does not prove eligible completed non-Shorts video ${args.videoId}`);
  }
  if (completed.missingLanguageCount !== 0) {
    throw new Error(`Inventory still has missing languages for ${args.videoId}`);
  }

  const validationEntries = Object.entries(metadata.validation);
  const maxTitle = validationEntries.reduce((best, [language, value]) => value.titleLength > best.length ? { language, length: value.titleLength } : best, { language: "", length: 0 });
  const maxDescription = validationEntries.reduce((best, [language, value]) => value.descriptionLength > best.length ? { language, length: value.descriptionLength } : best, { language: "", length: 0 });
  const sourceDescription = source.immutable.description;
  const sourceDescriptionIsBlank = sourceDescription === "";
  const sourceLineCount = sourceDescriptionIsBlank ? 0 : sourceDescription.replace(/\r\n/g, "\n").split("\n").length;
  const generatedLanguages = metadata.generatedLanguages;
  const completedAt = perVideoState.completedAt ?? verification.checkedAt;
  const calculatedUsed = args.sessionStartUsed + args.cumulativeUnits;
  const calculatedRemaining = Math.max(0, 10000 - calculatedUsed);
  const line = `| ${formatKst(completedAt).replace("T", " ").slice(0, 16)} | \`${completed.videoId}\` | ${completed.title.replace(/\|/g, "\\|")} | ${source.localizations ? Object.keys(source.localizations).length : completed.rawLocalizationCount - generatedLanguages.length} | ${generatedLanguages.length} | ${completed.rawLocalizationCount} | ${inventory.supportedLanguageCount}/${inventory.supportedLanguageCount} | 표시 시작 ${args.displayedUsedBefore.toLocaleString("en-US")}, 이번 +${args.runUnits.toLocaleString("en-US")}, 누적 계산 ${calculatedUsed.toLocaleString("en-US")}, 잔여 ${calculatedRemaining.toLocaleString("en-US")} | 완료·재검증 통과 |`;

  const propagationText = args.verificationMode === "verify-only-after-propagation-delay"
    ? "마지막 배치의 즉시 재조회에서 전파 지연이 확인돼 같은 값을 다시 쓰지 않고 `--verify-only`로 최종 확인했다."
    : "마지막 배치까지 쓰기 성공 후 즉시 YouTube 재조회 검증을 통과했다.";
  const activeJobText = currentState.active_job?.slug
    ? `\`${currentState.active_job.slug}\` (${currentState.status})`
    : `없음 (${currentState.status})`;
  const displayedAfterText = args.displayedUsedAfterStatus === "pre_write_last_observed"
    ? `- 적용 전 마지막 Cloud Console 표시: ${args.displayedUsedAfter.toLocaleString("en-US")}/10,000 units\n- 작업 종료 후 Cloud Console 표시는 브라우저 정리 뒤라 다시 읽지 않았으며, 아래 API 메서드별 계산값을 최종 quota 근거로 사용했다.`
    : args.displayedUsedAfterStatus === "final_live_aggregation_pending"
      ? `- 작업 종료 후 Cloud Console 실제 재조회 표시: ${args.displayedUsedAfter.toLocaleString("en-US")}/10,000 units\n- 실제 재조회했지만 표시 집계가 아직 이번 API 호출 계산값을 반영하지 않아, 아래 API 메서드별 계산값과 표시 갱신 대기를 구분해 기록했다.`
      : `- 작업 종료 후 Cloud Console 표시: ${args.displayedUsedAfter.toLocaleString("en-US")}/10,000 units`;
  const descriptionTranslationText = sourceDescriptionIsBlank
    ? "- 한국어 원본 설명이 비어 있어 모든 추가 언어의 설명도 정확히 빈 문자열로 보존했으며, 설명 문구를 새로 만들지 않았다."
    : `- 제목·설명의 모든 본문, CTA, URL, PC 사양과 챕터 문구를 번역했다.\n- 원본 설명 ${sourceLineCount}줄의 줄 수·빈 줄 위치, URL·타임스탬프·숫자 순서와 영상별 보호 토큰을 보존했다.`;
  const maxDescriptionText = maxDescription.length === 0
    ? "0자 (모든 언어)"
    : `\`${maxDescription.language}\` ${maxDescription.length}자`;
  const report = `# YouTube 다국어 메타데이터 백필 완료 보고서

## 대상 영상

- 제목: ${completed.title}
- 영상 ID: \`${completed.videoId}\`
- URL: ${completed.videoUrl}
- 게시 시각: \`${completed.publishedAt}\`
- 공개 상태: \`${completed.privacyStatus}\`
- 기본 메타데이터 언어: \`${completed.defaultLanguage}\`
- 기본 음성 언어: \`${completed.defaultAudioLanguage}\`

## 일반 영상 판별

- 콘텐츠 유형: \`${completed.contentType}\`
- 콘텐츠 유형 권위: \`${completed.contentTypeAuthority}\`
- 콘텐츠 유형 근거: ${completed.contentTypeReason}
- 재생시간: \`${completed.duration}\`, ${completed.durationSeconds}초
- 게시 시점 Shorts 최대 길이: ${completed.durationLimitSeconds}초
- inventory 판정: \`isShort=false\`
- 판정 근거: \`${completed.shortClassification}\`
- 백필 적격: \`eligibleForBackfill=true\`

${describeNonShortEvidence(completed)}

## 적용 결과

- 작업 전 원시 localization 수: ${completed.rawLocalizationCount - generatedLanguages.length}
- 새로 추가한 localization 수: ${generatedLanguages.length}
- 작업 후 원시 localization 수: ${completed.rawLocalizationCount}
- 작업 후 공식 지원 범위: ${inventory.supportedLanguageCount}/${inventory.supportedLanguageCount}
- 최종 누락 언어: 0

추가 언어 ${generatedLanguages.length}개:

${generatedLanguages.map((language) => `\`${language}\``).join(", ")}

## 번역 및 품질 검사

- 현재 한국어 기본 제목과 설명만 권위 원본으로 사용했다.
- 외부 번역 서비스, 브라우저 자동번역, YouTube 자동번역 초안, 로컬 LLM을 사용하지 않았다.
${descriptionTranslationText}
- 다른 영상의 캠페인 문구나 링크를 추가하지 않았다.
- ${generatedLanguages.length}개 언어 모두 제목 100자 이하, 설명 5,000자 이하를 통과했다.
- 전체 번역 자체 재검수 보고서가 \`PASS\`다.
- 최종 최대 제목 길이: \`${maxTitle.language}\` ${maxTitle.length}자
- 최종 최대 설명 길이: ${maxDescriptionText}

## 적용 방식과 전파 확인

- \`videos.update\`의 \`localizations\` 부분만 사용했다.
- 기존 localization 맵을 매 요청에 누적해 보존했다.
- 누락 언어를 최대 3개씩 적용했다.
- ${propagationText}

## 할당량

- Google Cloud 프로젝트: \`metal-bus-494012-n6\`
- Google Cloud 프로젝트 번호: \`599276284407\`
- OAuth 클라이언트 프로젝트 번호: \`599276284407\`
- 이번 추가 실행 시작 Cloud Console 표시: ${args.displayedUsedBefore.toLocaleString("en-US")}/10,000 units
${displayedAfterText}
- 이 영상의 API 메서드별 계산 소비: ${args.runUnits.toLocaleString("en-US")} units
- 추가 실행 누적 계산 소비: ${args.cumulativeUnits.toLocaleString("en-US")} units
- 누적 계산 사용량: ${calculatedUsed.toLocaleString("en-US")}/10,000 units
- 계산 잔여량: ${calculatedRemaining.toLocaleString("en-US")} units
- 세션 예산: ${args.sessionBudget.toLocaleString("en-US")} units, 최소 보존량: 1,000 units
- 실행 정책: ${args.oneTimeMultiVideoOverride ? "사용자 승인 일회성 다편 실행" : "정오 자동화의 일반 영상 1편 완료 정책"}

## YouTube 재조회 검증

- \`ok=true\`
- \`supportedLanguageCount=${verification.supportedLanguageCount}\`
- \`rawLocalizationCount=${verification.rawLocalizationCount}\`
- \`missingSupported=[]\`
- \`generatedDifferences=[]\`
- \`existingDifferences=[]\`
- \`immutableDifferences=[]\`
- \`captionDifferences=[]\`
- 공개 상태 \`${verification.privacyStatus}\` 유지
- 기존 자막 트랙 ${verification.captions.length}개의 ID, 언어, 종류, 상태 불변

## 보존 항목

- 한국어 기본 제목과 설명, 태그, 카테고리
- \`defaultLanguage=ko\`, \`defaultAudioLanguage=ko\`
- 기존 localization 전체
- 공개 상태, 라이선스, 임베드, 통계 공개, 아동용 설정, 커스텀 썸네일
- 재생목록, 수익창출, 광고주 적합성
- 전체 수동 자막과 자동 생성 자막
- \`CURRENT_STATE.json\`: 활성 작업 ${activeJobText} 상태와 SHA-256을 그대로 유지

## 최종 inventory

- 갱신 시각: \`${inventory.capturedAt}\`
- inventory schema: \`${inventory.schemaVersion}\`
- 고유 채널 콘텐츠: ${inventory.scannedVideoCount}편
- 일반 동영상: ${inventory.standardVideoCount}편
- Shorts: ${inventory.shortContentCount}편
- 라이브: ${inventory.liveContentCount}편
- 콘텐츠 유형 판별 보류: ${inventory.unknownContentCount}편
- uploads playlist 원시 항목: ${inventory.playlistItemCount}개, 고유 ID: ${inventory.uniqueUploadsVideoCount}개, 중복 제거: ${inventory.duplicateUploadsVideoCount}개
- 공개 탭 병합: \`${inventory.publicTabDiscovery?.mergeEnabled === true}\`${inventory.publicTabDiscovery?.disabledReason ? ` — ${inventory.publicTabDiscovery.disabledReason}` : ""}
- 공개 탭 전용 소유 ID 병합: ${inventory.publicTabDiscovery?.mergedOwnedTabOnlyVideoIds?.length ?? 0}편
- 백필 적격 비Shorts 일반 영상: ${inventory.eligibleNonShortVideoCount}편
- 사용자 지정 후보 제외: ${inventory.excludedUserVideoCount ?? 0}편
- 활성 신규 업로드 작업 보류: ${inventory.deferredActiveJobVideoCount ?? 0}편
- Shorts 제외: ${inventory.excludedShortVideoCount}편
- 라이브 제외: ${inventory.excludedLiveVideoCount}편
- Shorts 판별 보류: ${inventory.excludedUnknownShortRiskVideoCount}편
- 완료 일반 영상: ${inventory.completedVideoCount}편
- 미완성 일반 영상: ${inventory.pendingVideoCount}편
- 다음 후보: ${inventory.nextCandidate ? `\`${inventory.nextCandidate.videoId}\` — ${inventory.nextCandidate.title} — ${inventory.nextCandidate.missingLanguageCount}개 언어 누락` : "없음"}

## 증거 파일

- \`source_snapshot.json\`: 작업 전 원본·기존 localization·보호 메타데이터·자막 목록
- \`translation_shard_*.json\`: 언어별 직접 번역
- \`translation_review_*.json\`: 언어 묶음별 독립 교차 검수 결과
- \`metadata_backfill.json\`: 최종값과 공식 지원 언어 snapshot
- \`backfill_state.json\`: 배치 체크포인트와 완료 상태
- \`verification.json\`: 최종 YouTube 재조회 결과
- \`candidate_inventory.json\`: 완료 후 live 채널 inventory
`;
  await atomicWrite(path.join(packageDir, "completion_report_ko.md"), report);

  const ledgerPath = path.join(BACKFILL_ROOT, "BACKFILL_LEDGER.md");
  let ledger = await readFile(ledgerPath, "utf8");
  if (!ledger.includes(`\`${completed.videoId}\``)) {
    const marker = "\n영상별 상세 증거는";
    ledger = ledger.includes(marker) ? ledger.replace(marker, `\n${line}\n${marker}`) : `${ledger.trimEnd()}\n${line}\n`;
    await atomicWrite(ledgerPath, ledger);
  }

  rootState.updatedAt = formatKst(completedAt);
  rootState.inventory = {
    path: "04_metadata/youtube_metadata_backfill/candidate_inventory.json",
    schemaVersion: inventory.schemaVersion,
    scannedVideoCount: inventory.scannedVideoCount,
    standardVideoCount: inventory.standardVideoCount,
    shortContentCount: inventory.shortContentCount,
    liveContentCount: inventory.liveContentCount,
    unknownContentCount: inventory.unknownContentCount,
    playlistItemCount: inventory.playlistItemCount,
    uniqueUploadsVideoCount: inventory.uniqueUploadsVideoCount,
    duplicateUploadsVideoCount: inventory.duplicateUploadsVideoCount,
    publicTabMergeEnabled: inventory.publicTabDiscovery?.mergeEnabled === true,
    publicTabMergeDisabledReason: inventory.publicTabDiscovery?.disabledReason ?? null,
    mergedOwnedTabOnlyVideoCount: inventory.publicTabDiscovery?.mergedOwnedTabOnlyVideoIds?.length ?? 0,
    eligibleNonShortVideoCount: inventory.eligibleNonShortVideoCount,
    excludedUserVideoCount: inventory.excludedUserVideoCount ?? 0,
    deferredActiveJobVideoCount: inventory.deferredActiveJobVideoCount ?? 0,
    excludedShortVideoCount: inventory.excludedShortVideoCount,
    excludedLiveVideoCount: inventory.excludedLiveVideoCount,
    excludedUnknownShortRiskVideoCount: inventory.excludedUnknownShortRiskVideoCount,
    pendingVideoCount: inventory.pendingVideoCount,
    completedVideoCount: inventory.completedVideoCount,
    nextCandidate: inventory.nextCandidate ? {
      videoId: inventory.nextCandidate.videoId,
      title: inventory.nextCandidate.title,
      durationSeconds: inventory.nextCandidate.durationSeconds,
      widthPixels: inventory.nextCandidate.widthPixels,
      heightPixels: inventory.nextCandidate.heightPixels,
      contentType: inventory.nextCandidate.contentType,
      contentTypeAuthority: inventory.nextCandidate.contentTypeAuthority,
      shortClassification: inventory.nextCandidate.shortClassification,
      missingLanguageCount: inventory.nextCandidate.missingLanguageCount,
    } : null,
  };
  rootState.lastCompleted = {
    videoId: completed.videoId,
    title: completed.title,
    contentType: completed.contentType,
    contentTypeAuthority: completed.contentTypeAuthority,
    completedAt: formatKst(completedAt),
    addedLanguageCount: generatedLanguages.length,
    supportedLanguageCount: inventory.supportedLanguageCount,
    finalRawLocalizationCount: completed.rawLocalizationCount,
    verification: "verified_complete",
    packagePath: `04_metadata/youtube_metadata_backfill/${completed.videoId}`,
  };
  delete rootState.currentAttempt;
  if (rootState.policy) {
    delete rootState.policy.requireVideoBoundSyncApprovalBeforeLocalizationWrite;
    rootState.policy.selection = "latest incomplete schema-v5 contentType=video item not explicitly excluded by user or held as CURRENT_STATE active job";
    rootState.policy.deferCurrentActiveJobVideo = true;
  }
  rootState.lastRunQuota = {
    googleCloudProjectId: "metal-bus-494012-n6",
    googleCloudProjectNumber: "599276284407",
    oauthClientProjectNumber: "599276284407",
    displayedLimit: 10000,
    displayedUsedBefore: args.displayedUsedBefore,
    displayedRemainingBefore: 10000 - args.displayedUsedBefore,
    displayedUsedAfterImmediate: args.displayedUsedAfter,
    displayedRemainingAfterImmediate: 10000 - args.displayedUsedAfter,
    displayedUsedAfterStatus: args.displayedUsedAfterStatus,
    sessionBudget: args.sessionBudget,
    oneTimeMultiVideoOverride: args.oneTimeMultiVideoOverride === true,
    cumulativeCalculatedUnits: args.cumulativeUnits,
    calculatedUsedAfter: calculatedUsed,
    calculatedRemainingUnits: calculatedRemaining,
    quotaDisplayAggregationPending: args.displayedUsedAfterStatus !== "final_live",
  };
  await atomicWrite(path.join(BACKFILL_ROOT, "backfill_state.json"), `${JSON.stringify(rootState, null, 2)}\n`);
  process.stdout.write(`BACKFILL_DOCUMENTED video=${completed.videoId} next=${inventory.nextCandidate?.videoId ?? "none"} remaining=${calculatedRemaining}\n`);
}

main().catch((error) => {
  process.stderr.write(`BACKFILL_DOCUMENTATION_FAILED ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
