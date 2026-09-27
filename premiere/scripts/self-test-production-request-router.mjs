import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import os from "node:os";

// 고정 예시: 채널 둘(기본 Main + DENO PICTURES 별칭), 상류 리포·썸네일 작업공간 임시 폴더. 라우터는 이 환경을 적재 때 읽는다.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "production-router-fixture-"));
const fixtureRuntime = path.join(fixtureRoot, "upload-runtime");
const fixtureUpstream = path.join(fixtureRoot, "creative-upstream");
const fixtureThumbs = path.join(fixtureRoot, "thumbnail-workspace");
fs.mkdirSync(fixtureRuntime, {recursive: true});
fs.mkdirSync(path.join(fixtureUpstream, "docs", "runbooks"), {recursive: true});
fs.mkdirSync(fixtureThumbs, {recursive: true});
fs.writeFileSync(path.join(fixtureUpstream, "AGENTS.md"), "# upstream\n");
fs.writeFileSync(path.join(fixtureUpstream, "docs", "runbooks", "premiere-postproduction.md"), "# handoff\n");
fs.writeFileSync(path.join(fixtureThumbs, "AGENTS.md"), "# thumbs\n");
fs.writeFileSync(
  path.join(fixtureRuntime, "channels.json"),
  JSON.stringify({
    defaultChannel: "main",
    channels: [
      {id: "main", title: "Main Channel", handle: "@main", youtubeChannelId: "UC0123456789abcdefghijkl", descriptionLinks: {comfyReferral: true, discord: true, tutorialBlocks: true}},
      {id: "pictures", title: "DENO PICTURES", handle: "@pictures", youtubeChannelId: "UCabcdefghijkl0123456789", aliases: ["디노픽쳐스", "디노픽처스"]},
    ],
  }),
);
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = fixtureRuntime;
process.env.DENO_CREATIVE_UPSTREAM_ROOT = fixtureUpstream.replace(/\\/g, "/");
process.env.DENO_THUMBNAIL_WORKSPACE_ROOT = fixtureThumbs.replace(/\\/g, "/");
const {resolveProductionRequest} = await import("./lib/production-request-router.mjs");

const REMOVED_POLICY_KEYS = [
  "allowedTimelineMutations",
  "forbidden",
  "requiredUserGate",
  "stopAt",
  "nextValidTransitions",
];

let passed = 0;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function test(name, request, verify) {
  const route = resolveProductionRequest(request);
  verify(route);
  for (const workflow of route.workflows) {
    if (workflow.endsWith(".md") && !workflow.includes("<")) {
      assert.ok(fs.existsSync(path.isAbsolute(workflow) ? workflow : path.join(repoRoot, workflow)), `missing workflow: ${workflow}`);
    }
  }
  for (const key of REMOVED_POLICY_KEYS) {
    assert.equal(key in route, false, `${key} must not be router policy`);
  }
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

test("통파일만 remains an editorial scope signal", "인트로부분은 건들지말고 통파일만 오디오 파형 컷 해줘", (route) => {
  assert.equal(route.intent, "editorial-cut");
  assert.equal(route.domain, "edit");
  assert.equal(route.scope.preserveIntro, true);
  assert.equal(route.scope.targetWholeFileOnly, true);
  assert.equal(route.scope.removeUselessSegments, true);
  assert.ok(route.workflows.includes("docs/agent/workflows/premiere-control.md"));
});

test("a plain timeline cut request is an editorial cut", "프리미어프로 타임라인 컷편집 부탁해", (route) => {
  assert.equal(route.recognized, true);
  assert.equal(route.intent, "editorial-cut");
  assert.ok(route.workflows.includes("docs/agent/workflows/audio-finishing.md"));
});

test("repeat and duplicate speech removal is an editorial cut", "위스퍼도 돌리고 프리미어 타임라인에 내가 지금 캡션올려놓은것까지 같이 고려해서 내가 했던말 또하고 중복된말하거나 그런거도 걷어내고 자연스럽게 이어지도록 전체 다듬어봐줄래?", (route) => {
  assert.equal(route.recognized, true);
  assert.equal(route.intent, "editorial-cut");
  assert.equal(route.domain, "edit");
  assert.equal(route.scope.removeUselessSegments, true);
});

test("explicit waveform-only wording stays waveform-only", "오디오 파형 기준으로만 해. 문맥 관리는 내가 할게.", (route) => {
  assert.equal(route.intent, "waveform-only-cut");
  assert.equal(route.scope.removeUselessSegments, false);
});

// 2026-09-28 디노 wording (was routed to editorial-cut).
for (const request of [
  "프리미어프로 타임라인 컷편집 뒷부분에 있는 큰거 2개 파일만 오디오 파형기준으로 컷편집 해주면 좋겠어 맥락까지 확인하고 네가 컷편집 하니까 오히려 내가 편집할때 불편하더라 그래서 그냥 오디오 파형 기준으로 앞뒤 0.15초씩 해서 0.3초 여유 시간 남기고 기계적으로 컷편집 진행해줘",
  "파형 기준으로 기계적으로 컷편집해줘",
]) {
  test(`mechanical waveform cut stays waveform-only: ${request.slice(0, 24)}`, request, (route) => {
    assert.equal(route.intent, "waveform-only-cut");
    assert.equal(route.scope.removeUselessSegments, false);
  });
}

test("motion after cut selects the established motion workflow", "컷은 끝났고 범위 마커 안에 모션 작업하자", (route) => {
  assert.equal(route.intent, "motion-production");
  assert.equal(route.scope.protectExistingCuts, true);
  assert.ok(route.workflows.includes("docs/agent/workflows/channel-motion-profile.md"));
  assert.match(route.guidance.join(" "), /current live edit/iu);
});

for (const request of ["Claude처럼 다시 해", "예전 작업감으로 다시 해", "기존 Claude와 다르다"]) {
  test(`short Claude-parity trigger selects motion: ${request}`, request, (route) => {
    assert.equal(route.intent, "motion-production");
    assert.match(route.guidance.join(" "), /channel motion profile/iu);
  });
}

test("avatar longform adds a profile without replacing existing motion", "기존 롱폼 모션작업 문서는 그대로 두고 얼굴있는 아바타용 롱폼 문법을 추가해서 시범 운영", (route) => {
  assert.equal(route.intent, "motion-production");
  assert.ok(route.workflows.includes("docs/agent/workflows/avatar-longform-direction.md"));
  assert.ok(route.workflows.includes("docs/agent/workflows/channel-motion-profile.md"));
  assert.ok(route.workflows.includes("docs/agent/workflows/motion-craft.md"));
});

test("avatar lecture shot direction routes to motion", "내 아바타 강의 샷 연출로 시범 해보자", (route) => {
  assert.equal(route.intent, "motion-production");
  assert.ok(route.workflows.includes("docs/agent/workflows/avatar-longform-direction.md"));
});

test("ordinary motion loads the approved presenter profile for scope assessment", "모션 작업하자", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/avatar-longform-direction.md"));
});

test("approved three-view wardrobe reuse reaches the motion default", "성공했던 LTX용 시작이미지 3장에서 앞으로 옷만 바꾸면서 쓰는 걸 모션작업 기본문법으로 반영해줘", (route) => {
  assert.equal(route.intent, "motion-production");
  assert.ok(route.workflows.includes("docs/agent/workflows/avatar-longform-direction.md"));
  assert.ok(route.workflows.includes("docs/agent/workflows/channel-motion-profile.md"));
});

test("raw LTX avatar clip generation remains upstream", "LTX로 내 아바타 영상 생성해줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
  assert.ok(!route.workflows.includes("docs/agent/workflows/avatar-longform-direction.md"));
});

test("an avatar lecture sample alone does not imply motion editing", "LTX로 내 아바타 강의 샘플 생성해줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
});

test("motion plus audio selects both workflows", "클로드처럼 모션 다시 하면서 오디오 밸런스도 맞춰줘", (route) => {
  assert.equal(route.intent, "audio-and-motion-finishing");
  assert.ok(route.workflows.includes("docs/agent/workflows/audio-finishing.md"));
  assert.ok(route.workflows.includes("docs/agent/workflows/motion-production.md"));
});

// 2026-09-27: this sentence routed to motion only, so the caption and audio workflows were not offered.
test("audio, captions and motion in one request select all three", "컷편집 다 했어 이제 오디오 파형 조절이랑 자막 작업이랑 모션작업까지 전부 진행해줘", (route) => {
  assert.equal(route.intent, "audio-caption-motion-finishing");
  assert.equal(route.scope.protectExistingCuts, true);
  for (const workflow of ["audio-finishing.md", "caption-production.md", "motion-production.md", "channel-motion-profile.md", "premiere-control.md"]) {
    assert.ok(route.workflows.includes(`docs/agent/workflows/${workflow}`), workflow);
  }
});

test("captions plus motion select both workflows", "자막이랑 모션 같이 넣어줘", (route) => {
  assert.equal(route.intent, "caption-and-motion-finishing");
  assert.ok(route.workflows.includes("docs/agent/workflows/caption-production.md"));
  assert.ok(!route.workflows.includes("docs/agent/workflows/audio-finishing.md"));
});

test("an audio waveform cut stays a cut", "오디오 파형 컷 해줘", (route) => {
  assert.notEqual(route.intent, "audio-finishing");
  assert.ok(!route.workflows.includes("docs/agent/workflows/caption-production.md"));
});

for (const request of ["기본폰트 쓰지 말고 상황에 맞는 서체 골라줘", "간결한 영어 모션과 굵은 타이포그래피로 가자", "Adobe Fonts 준비해줘"]) {
  test(`typography policy is reachable: ${request}`, request, (route) => {
    assert.equal(route.intent, "motion-production");
    assert.ok(route.workflows.includes("docs/agent/workflows/motion-typography.md"));
  });
}

test("audio-only finishing preserves the approved edit signal", "컷은 끝났어. 오디오 정규화만 해줘.", (route) => {
  assert.equal(route.intent, "audio-finishing");
  assert.equal(route.domain, "audio");
  assert.equal(route.scope.protectExistingCuts, true);
});

test("A-to-Z requires explicit whole-production wording", "원본 통파일부터 완성본까지 영상 전체를 맡아줘", (route) => {
  assert.equal(route.intent, "full-video-production");
  assert.equal(route.domain, "master");
});

test("cut-complete master request selects the master workflow", "컷 끝났어. 영상 마스터까지 자동 진행해.", (route) => {
  assert.equal(route.intent, "video-master-production");
  assert.equal(route.scope.protectExistingCuts, true);
});

test("direct render request selects implemented export execution", "현재 시퀀스 최종 렌더링 해줘", (route) => {
  assert.equal(route.intent, "master-render");
  assert.equal(route.mode, "render-current-sequence");
  assert.match(route.guidance.join(" "), /official UXP export or AME route/iu);
});

test("YouTube caption upload selects publishing without inventing write policy", "최종 자막 SRT를 유튜브에 업로드해줘", (route) => {
  assert.equal(route.intent, "publishing-handoff");
  assert.equal(route.domain, "publishing");
  assert.ok(route.workflows.includes("docs/agent/workflows/publishing-handoff.md"));
});

test("prepare-only Upload Helper work is immediately routable", "마스터는 나중에 넣을게. 업로드 헬퍼 제목 설명부터 준비해줘", (route) => {
  assert.equal(route.intent, "publishing-handoff");
  assert.match(route.guidance.join(" "), /bind the exact master/iu);
});

for (const request of [
  "태그 오타 변형 많이 넣어줘",
  "제목 후보 리스트 더 추천해봐",
  "캠페인 조건에 맞춰 고정댓글 초안 준비해줘",
]) {
  test(`metadata and campaign authoring reaches its authority: ${request}`, request, (route) => {
    assert.equal(route.intent, "publishing-handoff");
    assert.deepEqual(route.workflows, ["docs/agent/workflows/publishing-handoff.md"]);
  });
}

for (const request of [
  "READY 저장했어 업로드 진행해줘",
  "업로드 요청 저장했다 진행해줘",
  "기존 영상 제목 설명 전체 현지화해줘",
  "유튜브 영상 공개 전환해줘",
  "업로드된 영상 태그 수정해줘",
]) {
  test(`execution retains authoring and execution routes: ${request}`, request, (route) => {
    assert.deepEqual(route.workflows, [
      "docs/agent/workflows/publishing-handoff.md",
      "docs/agent/workflows/youtube-upload-execution.md",
    ]);
  });
}

test("re-encode and reupload routes each requested stage", "타임라인 수정했어 다시 인코딩해서 영상만 그대로 다시 올려줘", (route) => {
  assert.deepEqual(route.workflows, [
    "docs/agent/workflows/premiere-control.md",
    "docs/agent/workflows/publishing-handoff.md",
    "docs/agent/workflows/youtube-upload-execution.md",
  ]);
});

test("multi-platform publishing selects its own execution contract", "숏폼 유튜브 인스타 Threads X에 예약 게시해줘", (route) => {
  assert.equal(route.intent, "social-publishing");
  assert.deepEqual(route.workflows, ["docs/agent/workflows/social-publishing.md"]);
});

// 업로드 채널 하드룰(디노 2026-09-25): "올려"도 업로드이고, 채널 안내가 항상 따라간다.
for (const request of ["이거 디노픽쳐스에 올려줘", "DENO PICTURES에 업로드해", "이거 유튜브에 올려줘"]) {
  test(`YouTube upload wording reaches execution with the channel rule: ${request}`, request, (route) => {
    assert.equal(route.intent, "publishing-handoff");
    assert.deepEqual(route.workflows, [
      "docs/agent/workflows/publishing-handoff.md",
      "docs/agent/workflows/youtube-upload-execution.md",
    ]);
    assert.match(route.guidance.join(" "), /unless the user explicitly named DENO PICTURES/iu);
  });
}

test("multilingual title expansion of uploaded videos reaches localization execution", "디노픽쳐스에 기존에 올라갔던 영상 제목만 다국어 확장해줘", (route) => {
  assert.equal(route.intent, "publishing-handoff");
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
  assert.match(route.guidance.join(" "), /unless the user explicitly named DENO PICTURES/iu);
});

test("DENO PICTURES shorts do not silently take the Deno-locked social lane", "디노픽쳐스 쇼츠 올려줘", (route) => {
  assert.equal(route.intent, "social-publishing");
  assert.deepEqual(route.workflows, [
    "docs/agent/workflows/social-publishing.md",
    "docs/agent/workflows/youtube-upload-execution.md",
  ]);
  assert.match(route.guidance.join(" "), /uploads to Main Channel \(@main\) only/iu);
});

test("long source outside Premiere selects source preparation", "프리미어 밖 긴 원본에서 클립 추출해줘", (route) => {
  assert.deepEqual(route.workflows, ["docs/agent/workflows/long-recording.md"]);
});

test("standalone Remotion export selects the runtime workflow", "Remotion 컴포지션 렌더해줘", (route) => {
  assert.deepEqual(route.workflows, ["docs/agent/workflows/remotion-runtime.md", "docs/agent/workflows/motion-craft.md"]);
});

test("document repair is reachable from actual feedback wording", "문서 라우팅 전체 구조 체크하고 메인 지침 보완해줘", (route) => {
  assert.equal(route.intent, "repo-authority-recovery");
  assert.deepEqual(route.workflows, ["AGENTS.md", "docs/agent/README.md"]);
});

test("optional thumbnail work does not require final captions or master", "최종 영상은 아직이지만 썸네일 먼저 만들어줘", (route) => {
  assert.equal(route.intent, "thumbnail-postwork");
  assert.match(route.guidance.join(" "), /current brief/iu);
});

test("thumbnail work points to the thumbnail workspace", "썸네일 만들어줘", (route) => {
  assert.equal(route.intent, "thumbnail-postwork");
  assert.match(route.guidance.join(" "), /thumbnail-workspace\/AGENTS\.md/u);
});

test("caption production selects caption and Premiere workflows", "최종 자막 SRT 만들어서 타임라인에 올려줘", (route) => {
  assert.equal(route.intent, "caption-production");
  assert.ok(route.workflows.includes("docs/agent/workflows/caption-production.md"));
  assert.ok(route.workflows.includes("docs/agent/workflows/premiere-control.md"));
});

test("resume does not ask the user to restate prior work", "재부팅됐어. 하던 작업 이어서 해줘.", (route) => {
  assert.equal(route.intent, "resume-current-production");
  assert.match(route.guidance.join(" "), /next unfinished operation/iu);
});

test("authority recovery remains separate from Premiere media work", "권위문서 원인 체크하고 repo 기준으로 복구해", (route) => {
  assert.equal(route.intent, "repo-authority-recovery");
  assert.equal(route.mode, "read-only");
});

test("sponsor brief routes to publishing handoff", "협찬 브리프 왔어 설명 보충해줘", (route) => {
  assert.equal(route.intent, "publishing-handoff");
  assert.ok(route.workflows.includes("docs/agent/workflows/publishing-handoff.md"));
});

test("editing an already uploaded video continues into youtube execution", "이미 올린 영상 설명 수정해줘", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

test("localization write routes to youtube execution", "번역 82개 언어 반영해줘", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

test("limiter request is audio finishing", "리미터 걸어줘", (route) => {
  assert.equal(route.intent, "audio-finishing");
});

test("bgm too loud is audio finishing", "BGM 너무 큰거 같다 줄여줘", (route) => {
  assert.equal(route.intent, "audio-finishing");
});

test("motion block error routes to motion production", "B06 에러 떠서 안된다", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/motion-production.md"));
});

test("script or clip generation is DenoVerse upstream", "3번 장면 클립 시댄스로 다시 생성해줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
  assert.ok(route.workflows.some((w) => w.endsWith("creative-upstream/AGENTS.md")));
});

test("character sheet request is DenoVerse upstream", "주인공 캐릭터 시트 만들어줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
});

test("motion using seedance clips stays motion, not upstream", "시댄스 클립 써서 모션 넣어줘", (route) => {
  assert.equal(route.intent, "motion-production");
});

test("bgm generation is upstream, bgm level is audio", "BGM 새로 만들어줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
});

test("caption sync fix stays under the caption hard rule, not publishing", "자막 싱크 밀렸어 맞춰줘", (route) => {
  assert.equal(route.intent, "caption-production");
});

test("sync confirmation wording still reaches publishing execution", "싱크 OK 업로드 진행해", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

test("education shorts captions belong to DenoVerse", "교육숏츠 자막 붙여줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
});

test("makjang intro belongs to DenoVerse", "막장드라마 인트로 만들어줘", (route) => {
  assert.equal(route.intent, "denoverse-upstream");
});

test("upload preparation routes to publishing handoff", "업로드 준비하자", (route) => {
  assert.equal(route.intent, "publishing-handoff");
});

// 2026-09-17 user wording after motion approval (was recognized:false).
test("starting the upload work routes to publishing handoff", "이제 업로드 작업 하면 좋겠어", (route) => {
  assert.equal(route.intent, "publishing-handoff");
  assert.ok(route.workflows.includes("docs/agent/workflows/publishing-handoff.md"));
});

test("title and description drafting routes to publishing handoff", "제목 설명 뽑아줘", (route) => {
  assert.equal(route.intent, "publishing-handoff");
});

// 2026-09-17: the user edited the title in the Upload Helper and pressed complete (READY saved).
test("saving edited Helper metadata continues to youtube execution", "제목 내가 원하는대로 수정해서 저장했어", (route) => {
  assert.equal(route.intent, "publishing-handoff");
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

// 2026-09-27: the user pressed the Upload Helper complete button (was recognized:false).
for (const request of ["완료 눌렀어", "완료 버튼 눌렀어요", "업로드 시작 눌렀어"]) {
  test(`pressing the Helper complete button continues to youtube execution: ${request}`, request, (route) => {
    assert.equal(route.intent, "publishing-handoff");
    assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
  });
}

test("drafting titles alone does not jump to execution", "제목 설명 뽑아줘", (route) => {
  assert.ok(!route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

test("public switch routes to youtube execution", "공개해줘", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

test("already uploaded description fix routes to youtube execution", "이미 올린 영상 설명 고쳐줘", (route) => {
  assert.ok(route.workflows.includes("docs/agent/workflows/youtube-upload-execution.md"));
});

test("4K re-render of the finished video is a master render", "완성본 4K로 다시 뽑아줘", (route) => {
  assert.equal(route.intent, "master-render");
});

test("progress question resumes the current production", "이 영상 후반부 어디까지 했어", (route) => {
  assert.equal(route.intent, "resume-current-production");
});

test("icon and paper texture feedback is motion", "아이콘 넣어서 다시 해줘, 배경은 종이질감으로", (route) => {
  assert.equal(route.intent, "motion-production");
});

test("unrelated text remains unrouted", "안녕하세요", (route) => {
  assert.equal(route.recognized, false);
});

for (const request of ["그 스킬을 참조해서 리모션으로 다시 만들어서 AB 비교영상 보여줘", "컷은 끝났고 모션 넣어줘", "모션과 오디오 밸런스도 맞춰줘"]) {
  test(`engine-independent craft skill is required: ${request}`, request, (route) => {
    assert.ok(route.workflows.includes("docs/agent/workflows/motion-craft.md"));
  });
}

console.log(`1..${passed}`);
