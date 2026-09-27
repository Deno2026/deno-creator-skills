import { createRequire } from "node:module";

const WORKFLOWS = Object.freeze({
  audio: "docs/agent/workflows/audio-finishing.md",
  captions: "docs/agent/workflows/caption-production.md",
  motion: "docs/agent/workflows/motion-production.md",
  motionProfile: "docs/agent/workflows/channel-motion-profile.md",
  avatarProfile: "docs/agent/workflows/avatar-longform-direction.md",
  motionTypography: "docs/agent/workflows/motion-typography.md",
  premiere: "docs/agent/workflows/premiere-control.md",
  publishing: "docs/agent/workflows/publishing-handoff.md",
  youtube: "docs/agent/workflows/youtube-upload-execution.md",
  social: "docs/agent/workflows/social-publishing.md",
  longRecording: "docs/agent/workflows/long-recording.md",
  remotion: "docs/agent/workflows/remotion-runtime.md",
  thumbnail: "docs/agent/workflows/thumbnail-production.md",
  video: "docs/agent/workflows/video-production.md",
});

// 업로드 채널: channels.json의 기본 채널이 기본이고, 사용자가 이번 업로드에 다른 채널을 이름으로 말했을 때만 그 채널이다(AGENTS.md 업로드 채널 하드룰).
// 채널 목록·별칭은 런타임 channels.json(@deno/runtime-paths)에서 읽는다 — 개인 채널 이름을 코드에 두지 않는다(2026-09-27).
const require = createRequire(import.meta.url);
const runtimePaths = require("../../packages/runtime-paths/index.cjs");
const PROFILE_ENV = { ...process.env, DENO_UPLOAD_HELPER_RUNTIME_ROOT: runtimePaths.resolveUploadRuntimeRootDefault() };
const CHANNEL_PROFILE = runtimePaths.loadPublishingProfile({ env: PROFILE_ENV });
const DEFAULT_CHANNEL = CHANNEL_PROFILE.channels.find((c) => c.id === CHANNEL_PROFILE.defaultChannel) ?? CHANNEL_PROFILE.channels[0];
const OTHER_CHANNELS = CHANNEL_PROFILE.channels.filter((c) => c.id !== DEFAULT_CHANNEL.id);
const channelLabel = (c) => (c.handle ? `${c.title} (${c.handle})` : c.title);
const UPLOAD_CHANNEL_GUIDANCE = OTHER_CHANNELS.length
  ? `Upload to ${channelLabel(DEFAULT_CHANNEL)} unless the user explicitly named ${OTHER_CHANNELS.map(channelLabel).join(" or ")} for this upload; never infer the channel from genre, intro, thumbnail or folder (AGENTS.md 업로드 채널 하드룰).`
  : `Upload to ${channelLabel(DEFAULT_CHANNEL)} (the only configured channel); never infer another channel from genre, intro, thumbnail or folder.`;
// 창작 상류 리포(대본·생성·완성본)와 썸네일 작업공간은 환경변수 또는 local.config.json이 가리킨다.
const LOCAL_CONFIG = runtimePaths.readLocalConfig();
const CREATIVE_UPSTREAM_ROOT = String(process.env.DENO_CREATIVE_UPSTREAM_ROOT ?? LOCAL_CONFIG.creativeUpstreamRoot ?? "").replace(/\\/g, "/").replace(/\/$/, "");
const THUMBNAIL_WORKSPACE_ROOT = String(process.env.DENO_THUMBNAIL_WORKSPACE_ROOT ?? LOCAL_CONFIG.thumbnailWorkspaceRoot ?? "").replace(/\\/g, "/").replace(/\/$/, "");

function normalizeRequest(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
}

function matches(text, pattern) {
  return pattern.test(text);
}

function commonResult(request, overrides) {
  return Object.freeze({
    request,
    recognized: true,
    intent: "unknown",
    mode: "unknown",
    domain: "unknown",
    workflows: [],
    liveReads: [],
    scope: {
      preserveIntro: false,
      targetWholeFileOnly: false,
      protectExistingCuts: false,
      removeUselessSegments: false,
    },
    guidance: [],
    ...overrides,
    workflows: [...new Set([
      ...(overrides.workflows ?? []),
      ...((overrides.workflows ?? []).includes(WORKFLOWS.motion)
        ? [WORKFLOWS.avatarProfile] : []),
      ...((overrides.workflows ?? []).some(workflow =>
        workflow === WORKFLOWS.motion || workflow === "docs/agent/workflows/remotion-runtime.md")
        ? ["docs/agent/workflows/motion-craft.md"] : []),
    ])],
  });
}

function requestScope(text) {
  return Object.freeze({
    preserveIntro: matches(text, /(?:인트로|intro).{0,12}(?:건들지|건드리지|유지|보존|제외|말고)/iu),
    targetWholeFileOnly: matches(
      text,
      /(?:통파일만|방금\s*(?:올린|얹은)\s*(?:통)?파일|선택(?:한|된)?\s*파일(?:만)?|이\s*파일만)/iu,
    ),
    protectExistingCuts: matches(
      text,
      /(?:컷(?:은|이|편집은)?\s*(?:끝|완료|확정|건들지|건드리지|유지)|컷\s*편집\s*(?:은\s*)?(?:다\s*)?(?:했|끝냈|마쳤)|기존\s*컷\s*(?:보존|유지))/iu,
    ),
    removeUselessSegments: matches(
      text,
      /(?:쓸모\s*없|불필요|명백한\s*(?:중복|재시작)|실패\s*테이크|말실수|재시도|중복\s*테이크|중복(?:된|되는)?\s*말|했던\s*말.{0,6}또)/iu,
    ),
  });
}

function isStrictWaveformOnly(text) {
  return matches(
    text,
    // "기계적으로", "맥락까지 확인하고 … 불편" = cut by waveform only (디노 2026-09-28: 문맥 판단 컷이 편집을 불편하게 했다).
    /(?:파형\s*(?:기준으로\s*)?만|소리\s*유무(?:만|로만)|문맥(?:\s*관리는|은)?\s*내가|의미\s*판단(?:은)?\s*(?:하지\s*마|금지)|semantic\s*(?:판단\s*)?(?:하지\s*마|금지)|기계\s*적으로|(?:맥락|문맥).{0,30}(?:불편|하지\s*마|보지\s*마|빼고))/iu,
  );
}

function isReadOnlyStop(text) {
  return matches(
    text,
    /(?:여기서부터|지금부터|일단).{0,18}(?:작업하지\s*말|건들지\s*말|멈춰)|(?:타임라인|프리미어).{0,12}(?:건들지\s*말|작업하지\s*말)|읽기\s*전용/iu,
  );
}

function isAuthorityRecovery(text) {
  return matches(
    text,
    /(?:(?:권위|agent(?:s)?\.md|에이전트\s*문서|repo\s*기준|문서\s*라우팅|라우팅\s*문서|문서\s*경로|메인\s*지침).{0,50}(?:원인|체크|복구|정리|충돌|보완|수정|반영)|클로드.{0,30}(?:아카이브|대화|사용감|기록).{0,30}(?:복구|살펴|반영))/iu,
  );
}

function isResume(text) {
  return matches(text, /(?:하던\s*작업|이어서|이어\s*하|계속\s*하|재개|재부팅.{0,16}(?:계속|이어서|하던)|어디까지\s*(?:했|됐|진행|왔)|(?:후반부|진행)\s*(?:상태|상황).{0,6}(?:알려|어때|보여))/iu);
}

function isFullProduction(text) {
  return matches(
    text,
    /(?:원본|통파일).{0,24}(?:완성본|업로드\s*직전|끝까지).{0,16}(?:맡|만들)|(?:영상\s*)?(?:전체|전부|a\s*[-–—~]\s*z).{0,18}(?:제작|맡)|처음부터\s*끝까지.{0,12}(?:제작|맡)/iu,
  );
}

function isMasterContinuation(text) {
  return matches(
    text,
    /(?:컷(?:은|이|편집은)?\s*(?:끝|완료|확정).{0,30}(?:영상\s*)?마스터(?:까지|\s*제작|\s*완성)|(?:영상\s*)?마스터(?:까지|\s*제작|\s*완성).{0,30}(?:진행|자동|해줘|만들))/iu,
  );
}

function isThumbnailPostwork(text) {
  return matches(text, /(?:썸네일|thumbnail)/iu);
}

function isPublishingPostwork(text) {
  return matches(
    text,
    /(?:업로드\s*헬퍼|upload\s*helper|퍼블리싱|재업로드|현지화|다국어|localization|고정\s*댓글|캠페인|협찬|브리프|스폰서|sponsor|brief|해시태그|hashtag|업로드\s*(?:준비|작업)|(?:제목|설명|썸네일\s*문구).{0,10}(?:뽑|만들|지어|써|정해)|(?:공개|퍼블릭|public)\s*(?:해|전환|로\s*바꿔|시켜)|(?:이미|벌써)\s*(?:올린|올라간|업로드한|게시한).{0,20}(?:고쳐|수정|바꿔|바꾸)|(?:번역|언어).{0,12}(?:반영|올려|적용|업로드)|\d+\s*개?\s*언어)|(?:(?:유튜브|youtube|디노\s*픽[쳐처]스|deno\s*pictures).{0,40}(?:업로드|게시|공개|올려|올리|제목|설명|챕터|태그|자막|캡션|싱크|마무리)|(?:업로드|게시|싱크|올려|올리).{0,40}(?:유튜브|youtube|디노\s*픽[쳐처]스|deno\s*pictures))|(?:영상|자막|캡션|srt).{0,12}(?:업로드|게시)|(?:제목|설명|챕터|태그).{0,40}(?:작성|확인|수정|정리|만들|추천|입력|추가|보완|넣|늘|많이)|업로드\s*(?:시작|진행|해|하자)|업로드\s*요청.{0,16}(?:저장|완료|했)|READY|다시\s*올려|(?:영상|유튜브).{0,12}공개\s*(?:해|전환)|싱크\s*(?:OK|오케이|이상\s*없|문제\s*없|확인\s*완료|맞아|맞음)|(?:완료|업로드\s*시작)\s*(?:버튼)?\s*(?:을|를)?\s*(?:눌렀|누름|클릭)/iu,
  );
}

function isPublishingExecution(text) {
  // "제목 … 수정해서 저장했어" = the user saved the Helper screen, i.e. a READY exists (2026-09-17).
  // "완료 눌렀어" = the user pressed 완료 · 업로드 시작, i.e. a READY exists (2026-09-27).
  return matches(text, /(?:(?:제목|설명|챕터|태그).{0,30}저장\s*(?:했|함|완료|끝)|READY|재업로드|다시\s*올려|현지화|다국어|localization|업로드된|게시된|(?:이미|벌써)\s*(?:올린|올라간|업로드한|게시한)|(?:번역|언어).{0,12}(?:반영|올려|적용|업로드)|\d+\s*개?\s*언어|(?:공개|퍼블릭|public)\s*(?:해|전환|로\s*바꿔|시켜))|업로드\s*(?:시작|진행|해|하자)|업로드\s*요청.{0,16}(?:저장|완료|했)|(?:영상|유튜브|youtube).{0,20}공개\s*(?:해|전환)|(?:유튜브|youtube|디노\s*픽[쳐처]스|deno\s*pictures).{0,20}올려|(?:싱크)\s*(?:OK|오케이|확인\s*완료|문제\s*없|이상\s*없|맞아|맞음)|(?:완료|업로드\s*시작)\s*(?:버튼)?\s*(?:을|를)?\s*(?:눌렀|누름|클릭)/iu);
}

// 기본 채널이 아닌 채널을 이름·핸들·별칭(channels.json aliases)으로 부르는가.
function namesOtherChannel(text) {
  const needles = OTHER_CHANNELS.flatMap((c) => [c.title, c.handle, ...(c.aliases ?? [])]).filter(Boolean);
  const haystack = String(text).replace(/\s+/gu, "").toLowerCase();
  return needles.some((needle) => haystack.includes(String(needle).replace(/\s+/gu, "").toLowerCase()));
}
const namesDenoPictures = namesOtherChannel;

function isSocialPublishing(text) {
  return matches(text, /(?:숏폼|쇼츠|shorts|릴스|reels|instagram|인스타|threads|스레드|tiktok|틱톡|다중\s*플랫폼|여러\s*플랫폼)/iu)
    && matches(text, /(?:예약|게시|업로드|배포|올려|publish)/iu);
}

function isLongRecording(text) {
  return matches(text, /(?:프리미어|premiere)\s*밖.{0,20}(?:원본|영상)|(?:긴\s*원본|장시간\s*(?:녹화|원본)|long\s*recording)/iu);
}

function isStandaloneRemotion(text) {
  return matches(text, /remotion|리모션/iu)
    && !matches(text, /premiere|프리미어|타임라인.{0,12}(?:배치|넣|반영)|오버레이/iu);
}

function wantsClaudeMotionParity(text) {
  return matches(
    text,
    /(?:(?:클로드|claude)\s*(?:처럼|같이|식으로)|(?:클로드|claude).{0,30}(?:모션|오버레이|사용감|작업감|스타일|다르)|(?:예전|기존).{0,30}(?:모션|오버레이|사용감|작업감|스타일|클로드|claude)|(?:모션|오버레이|사용감|작업감|스타일).{0,30}(?:클로드|claude|예전|기존))/iu,
  );
}

const DENOVERSE_ROOT = CREATIVE_UPSTREAM_ROOT || "<creative upstream repo — set DENO_CREATIVE_UPSTREAM_ROOT or local.config.json creativeUpstreamRoot>";
const DENOVERSE_WORKFLOWS = [
  `${DENOVERSE_ROOT}/AGENTS.md`,
  `${DENOVERSE_ROOT}/docs/runbooks/premiere-postproduction.md`,
];

// Creative upstream (script, casting, clip/image/music generation, shorts planning) is owned by the creative upstream repo (creativeUpstreamRoot).
// Only used when no Helper domain matched, so "시댄스 클립으로 모션 넣어줘" still routes to motion.
// Education shorts (TTS-based burned-in captions) and drama intros are upstream-owned formats even though
// the words "자막"/"인트로" appear; checked before the caption/publishing branches.
function isUpstreamOwnedFormat(text) {
  return matches(text, /(?:교육\s*숏츠|교육숏츠|번인\s*자막|caption-align|막장\s*(?:드라마)?\s*인트로|인트로\s*(?:만들|제작))/iu);
}

function isCreativeUpstream(text) {
  return matches(
    text,
    /(?:대본|시나리오|스토리라인|BRIEF|브리프\s*(?:쓰|만들|잡)|캐릭터\s*(?:시트|디자인|만들)|배우진|캐스팅|스토리보드|앵커\s*(?:이미지|만들)|(?:클립|장면|영상|이미지|음악|BGM|노래|앰비언트).{0,12}(?:생성|만들어|뽑아|다시\s*만들|새로)|(?:시댄스|seedance|ltx|minimax|h3|gemini\s*omni|krea|flux|suno|yue).{0,16}(?:생성|만들|돌려|뽑)|숏츠\s*(?:기획|아이디어)|프리비즈|previz)/iu,
  );
}

function isAvatarDirection(text) {
  return matches(text, /아바타|avatar/iu)
    && matches(text, /모션|오버레이|연출|문법|편집|타임라인/iu)
    && matches(text, /롱폼|강의|long.?form|lecture|타임라인|모션|오버레이/iu);
}

function isMotion(text) {
  return matches(text, /(?:모션(?:그래픽)?|오버레이|자료\s*화면|remotion|(?:^|\s)B\d{2}(?:-|\s|$)|블록.{0,12}(?:에러|오류|안\s*된|안된|깨|수정)|(?:미디어|클립).{0,8}오프라인|offline|relink|재연결|아이콘|마크\s*넣|(?:종이|무광|매트)\s*질감|질감\s*(?:배경|으로|바꿔)|배경.{0,6}질감)/iu) || wantsClaudeMotionParity(text)
    || isAvatarDirection(text)
    || (!isCaption(text) && matches(text, /(?:폰트|서체|타이포그래피|typography|adobe\s*fonts|google\s*fonts)/iu));
}

function isCaption(text) {
  return matches(text, /(?:자막|캡션|srt|받아쓰기)/iu);
}

function isAudioFinishing(text) {
  return matches(
    text,
    // "오디오 파형 조절" = the user's name for the whole-timeline balance (2026-09-27); "파형 컷" stays a cut (isCutEditing).
    /(?:오디오|소리|음성).{0,16}(?:정규화|밸런스|레벨|라우드니스|볼륨\s*맞|마감|보정)|(?:오디오|소리|음성)\s*(?:파형\s*)?(?:조절|조정)|(?:정규화|라우드니스).{0,12}(?:오디오|소리|음성)|리미터|limiter|(?:고점\s*)?피크.{0,12}(?:눌러|제한|잡아|누르)|(?:bgm|배경\s*음(?:악)?|음악|브금).{0,16}(?:크|커|작|줄|올|낮|키|시끄|묻)/iu,
  );
}

// Removing repeated or duplicated speech is a cut even when captions or Whisper are named as inputs.
function isRepeatSpeechRemoval(text) {
  return matches(text, /(?:중복(?:된|되는)?\s*말|했던\s*말.{0,6}또).{0,40}(?:걷어|빼|지워|없애|다듬)/iu);
}

function isCutEditing(text) {
  return matches(
    text,
    /(?:컷\s*편집|컷\s*해|잘라|통파일.{0,12}컷|파형.{0,12}컷|쓸모\s*없는\s*구간|실패\s*테이크|재시작|재시도\s*제거|(?:중복(?:된|되는)?\s*말|했던\s*말.{0,6}또).{0,40}(?:걷어|빼|지워|없애|다듬))/iu,
  );
}

function isRenderExport(text) {
  return matches(
    text,
    /(?:최종\s*)?(?:렌더(?:링)?|인코딩|내보내기|export|마스터\s*(?:파일|출력)|영상\s*출력).{0,20}(?:해|진행|시작|뽑|만들|부탁)|(?:렌더(?:링)?|내보내기|export)\s*(?:해줘|하자|진행)|(?:4k|2160|uhd).{0,12}(?:렌더|뽑|출력|내보|다시)|완성본.{0,12}(?:4k|2160|다시\s*뽑)/iu,
  );
}

/**
 * Selects the most relevant workflow and captures explicit scope signals.
 *
 * The selected workflow and live target provide the execution details.
 */
export function resolveProductionRequest(value) {
  const request = normalizeRequest(value);
  if (!request) {
    return commonResult(request, {
      recognized: false,
      guidance: ["Select the closest workflow from the current user request."],
    });
  }

  const scope = requestScope(request);

  if (isReadOnlyStop(request) || isAuthorityRecovery(request)) {
    const authorityRecovery = isAuthorityRecovery(request);
    return commonResult(request, {
      intent: authorityRecovery ? "repo-authority-recovery" : "read-only-audit",
      mode: "read-only",
      domain: "repo",
      workflows: authorityRecovery ? ["AGENTS.md", "docs/agent/README.md"] : [],
      liveReads: authorityRecovery
        ? ["current repo authority and implementation"]
        : ["only the live state needed for the requested diagnosis"],
      scope,
      guidance: ["Apply the requested repo audit or authority edit; repair the owning workflow and entry links, then verify routing."],
    });
  }

  if (isUpstreamOwnedFormat(request)) {
    return commonResult(request, {
      recognized: true,
      intent: "denoverse-upstream",
      mode: "creative-upstream",
      domain: "denoverse",
      scope,
      workflows: DENOVERSE_WORKFLOWS,
      liveReads: ["upstream production folder named by the user (생성상태.md, BRIEF.md)"],
      guidance: [
        `Education-shorts captions, drama intros and other upstream formats are owned by the creative upstream repo: follow ${DENOVERSE_ROOT}/AGENTS.md and its runbook instead of the Premiere workflows.`,
      ],
    });
  }

  if (isThumbnailPostwork(request) && !isMasterContinuation(request) && !isFullProduction(request)) {
    return commonResult(request, {
      intent: "thumbnail-postwork",
      mode: "optional-postwork",
      domain: "thumbnail",
      workflows: [WORKFLOWS.thumbnail],
      liveReads: ["current production identity", "current brief, captions, or master when useful"],
      scope,
      guidance: [
        "Start thumbnail work from the current brief, captions, or master artifact.",
        `Planning, generation and review follow the thumbnail workspace ${THUMBNAIL_WORKSPACE_ROOT || '<thumbnail workspace — set DENO_THUMBNAIL_WORKSPACE_ROOT>'}/AGENTS.md (outputs under its 07_thumbnail_system/outputs/); this repo only records the selection and applies it to YouTube.`,
      ],
    });
  }

  if (isSocialPublishing(request) && !isFullProduction(request)) {
    // The social YouTube lane is locked to the default channel and would silently upload another channel's video there.
    const denoPictures = namesDenoPictures(request);
    return commonResult(request, {
      intent: "social-publishing",
      mode: "post-production-handoff",
      domain: "publishing",
      workflows: [WORKFLOWS.social, ...(denoPictures ? [WORKFLOWS.youtube] : [])],
      liveReads: ["current approved publish manifest and selected platforms"],
      scope,
      guidance: [
        "Use the social publishing workflow and its linked input contract for selected platforms.",
        ...(denoPictures
          ? [`The social YouTube lane uploads to ${channelLabel(DEFAULT_CHANNEL)} only; upload a video for another channel through youtube-upload-execution with --channel <id>.`]
          : []),
      ],
    });
  }

  if (isPublishingPostwork(request) && !isMasterContinuation(request) && !isFullProduction(request)) {
    const execution = isPublishingExecution(request);
    const render = isRenderExport(request);
    return commonResult(request, {
      intent: "publishing-handoff",
      mode: "post-production-handoff",
      domain: "publishing",
      workflows: [...(render ? [WORKFLOWS.premiere] : []), WORKFLOWS.publishing, ...(execution ? [WORKFLOWS.youtube] : [])],
      liveReads: ["current production artifacts relevant to the requested publishing step"],
      scope,
      guidance: [
        "Read publishing-handoff metadata authoring rules, including relevant misspellings and spelling variants for tags; bind the exact master for upload.",
        UPLOAD_CHANNEL_GUIDANCE,
        ...(execution ? ["Continue the requested upload or live update through youtube-upload-execution using the current approval and exact video/request."] : []),
      ],
    });
  }

  if (isResume(request)) {
    return commonResult(request, {
      intent: "resume-current-production",
      mode: "resume",
      domain: "current",
      workflows: ["productions/<video-slug>/STATE.md when useful", "workflow for the current unfinished operation"],
      liveReads: ["current conversation pointer", "current artifacts and live Premiere state when relevant"],
      scope,
      guidance: ["Continue the next unfinished operation from current conversation, artifacts, and live state."],
    });
  }

  if (isMasterContinuation(request)) {
    return commonResult(request, {
      intent: "video-master-production",
      mode: "master-after-cut",
      domain: "master",
      workflows: [WORKFLOWS.video],
      liveReads: ["current approved edit and live sequence", "current production artifacts"],
      scope: {...scope, protectExistingCuts: true},
      guidance: ["Use the approved live edit as the source for the requested master work."],
    });
  }

  if (isFullProduction(request)) {
    return commonResult(request, {
      intent: "full-video-production",
      mode: "master-a-to-z",
      domain: "master",
      workflows: [WORKFLOWS.video],
      liveReads: ["active project, sequence, source media, and useful production state"],
      scope,
      guidance: ["Run cut, audio and motion, captions, and render in practical phases using confirmed decisions."],
    });
  }

  if (isLongRecording(request)) {
    return commonResult(request, {
      intent: "long-recording",
      mode: "source-preparation",
      domain: "edit",
      workflows: [WORKFLOWS.longRecording],
      liveReads: ["current source file and requested clip scope"],
      scope,
      guidance: ["Prepare derived clips using the long-recording workflow; follow its Premiere route when placing clips."],
    });
  }

  if (isStandaloneRemotion(request)) {
    return commonResult(request, {
      intent: "remotion-runtime",
      mode: "standalone-motion",
      domain: "motion",
      workflows: [WORKFLOWS.remotion],
      liveReads: ["current Remotion project and requested composition"],
      scope,
      guidance: ["Use the Remotion runtime workflow and the relevant Remotion skill."],
    });
  }

  if (isRenderExport(request)) {
    return commonResult(request, {
      intent: "master-render",
      mode: "render-current-sequence",
      domain: "master",
      workflows: [WORKFLOWS.video, WORKFLOWS.premiere],
      liveReads: [
        "current project and active sequence",
        "requested output and current export settings or preset",
      ],
      scope: {...scope, protectExistingCuts: true},
      guidance: ["Run the official UXP export or AME route with the requested output and verify the file."],
    });
  }

  // One request can name several finishing stages at once ("오디오 파형 조절이랑 자막 작업이랑 모션작업까지 전부", 2026-09-27):
  // route every named stage instead of the first match, so the caption hard rule is read with the motion workflows.
  if (isMotion(request) && (isAudioFinishing(request) || (isCaption(request) && !isRepeatSpeechRemoval(request)))) {
    const audio = isAudioFinishing(request);
    const captions = isCaption(request) && !isRepeatSpeechRemoval(request);
    return commonResult(request, {
      intent: audio && captions ? "audio-caption-motion-finishing" : audio ? "audio-and-motion-finishing" : "caption-and-motion-finishing",
      mode: "locked-edit-finishing",
      domain: "master",
      workflows: [
        ...(audio ? [WORKFLOWS.audio] : []),
        WORKFLOWS.motion, WORKFLOWS.motionProfile, WORKFLOWS.motionTypography,
        ...(captions ? [WORKFLOWS.captions] : []),
        WORKFLOWS.premiere,
      ],
      liveReads: [`current sequence, narration${audio ? ", audio map" : ""}${captions ? ", the user's SRT and existing caption track" : ""}, and established motion direction`],
      scope: {...scope, protectExistingCuts: true},
      guidance: [
        `Apply the requested ${[audio && "audio", "motion", captions && "caption"].filter(Boolean).join(", ")} work to the approved live edit.`,
        "Use the established channel motion profile.",
        ...(captions ? ["Captions start from the user's SRT (caption-production.md hard rule); apply them after the overlays are placed."] : []),
      ],
    });
  }

  if (isMotion(request)) {
    return commonResult(request, {
      intent: "motion-production",
      mode: "standalone-motion",
      domain: "motion",
      workflows: [WORKFLOWS.motion, WORKFLOWS.motionProfile, WORKFLOWS.motionTypography, WORKFLOWS.premiere],
      liveReads: ["current sequence, narration, markers, and accepted motion direction"],
      scope: {...scope, protectExistingCuts: scope.protectExistingCuts || matches(request, /컷.{0,8}(?:끝|완료|확정)/iu)},
      guidance: ["Apply the established channel motion profile to the current live edit."],
    });
  }

  if (isCaption(request) && !isRepeatSpeechRemoval(request)) {
    return commonResult(request, {
      intent: "caption-production",
      mode: "captions",
      domain: "captions",
      workflows: [WORKFLOWS.captions, WORKFLOWS.premiere],
      liveReads: ["current sequence, audio, and existing caption surface"],
      scope,
      guidance: ["Use the current live timeline and available caption artifacts, then complete the caption task requested by the user."],
    });
  }

  if (isAudioFinishing(request) && !isCutEditing(request)) {
    return commonResult(request, {
      intent: "audio-finishing",
      mode: "audio-finish-only",
      domain: "audio",
      workflows: [WORKFLOWS.audio, WORKFLOWS.premiere],
      liveReads: ["current sequence audio map and clip levels"],
      scope: {...scope, protectExistingCuts: true},
      guidance: ["Preserve clip timing and apply the requested audio adjustment."],
    });
  }

  if (isCutEditing(request) || isStrictWaveformOnly(request)) {
    const strictWaveformOnly = isStrictWaveformOnly(request);
    return commonResult(request, {
      intent: strictWaveformOnly ? "waveform-only-cut" : "editorial-cut",
      mode: strictWaveformOnly ? "strict-waveform-only" : "bounded-editorial",
      domain: "edit",
      workflows: [WORKFLOWS.audio, WORKFLOWS.premiere],
      liveReads: ["active sequence, target clip, fps, and target waveform"],
      scope: {...scope, removeUselessSegments: strictWaveformOnly ? false : true},
      guidance: strictWaveformOnly
        ? ["Use waveform silence as requested and preserve semantic decisions for the user."]
        : ["Use editorial judgment for obvious retakes while protecting spoken audio at waveform boundaries."],
    });
  }

  if (isCreativeUpstream(request)) {
    return commonResult(request, {
      recognized: true,
      intent: "denoverse-upstream",
      mode: "creative-upstream",
      domain: "denoverse",
      scope,
      workflows: DENOVERSE_WORKFLOWS,
      liveReads: ["upstream production folder named by the user (생성상태.md, BRIEF.md)"],
      guidance: [
        `Creative work (script, casting, storyboard, clip/image/music generation) is owned by the creative upstream repo: follow ${DENOVERSE_ROOT}/AGENTS.md before touching the Premiere timeline.`,
        "Keep originals in the upstream production folder; copy only what the Premiere post-production needs into assets/<slug>/ with source path and SHA noted.",
      ],
    });
  }

  return commonResult(request, {
    recognized: false,
    scope,
    guidance: ["Use docs/agent/README.md to select the closest current workflow."],
  });
}
