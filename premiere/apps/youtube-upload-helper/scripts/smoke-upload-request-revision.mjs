import { createHash, randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.UPLOAD_HELPER_URL || "http://127.0.0.1:3000";
const runtimeRoot = process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT?.trim();
if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) {
  throw new Error("DENO_UPLOAD_HELPER_RUNTIME_ROOT must be an absolute path for this smoke.");
}
// 설명 고정 링크는 서버가 읽는 런타임 channels.json과 같은 값을 쓴다(없으면 빈 값 — 링크 검사는 자연히 통과).
const profile = JSON.parse(await readFile(path.join(runtimeRoot, "channels.json"), "utf8").catch(() => "{}"));
const comfyReferralUrl = profile?.descriptionBlocks?.comfyReferral?.url ?? "";
const denoDiscordUrl = profile?.descriptionBlocks?.discord?.url ?? "";
const requestsRoot = path.join(runtimeRoot, "upload-requests");
const slug = `caption-revision-smoke-${randomUUID().slice(0, 8)}`;
const cinematicSlug = `cinematic-no-caption-smoke-${randomUUID().slice(0, 8)}`;
const createdRequestDirs = [];
const createdStageIds = [];
let stagedVideoId = "";

const revisionA = {
  cleanKorean:
    "1\n00:00:00,000 --> 00:00:01,000\n첫 번째 원본\n\n2\n00:00:01,000 --> 00:00:02,000\n같은 큐 수\n",
  english:
    "1\n00:00:00,000 --> 00:00:01,000\nFirst source\n\n2\n00:00:01,000 --> 00:00:02,000\nSame cue count\n",
};
const revisionB = {
  cleanKorean:
    "1\n00:00:00,000 --> 00:00:01,000\n두 번째 최신 원본\n\n2\n00:00:01,000 --> 00:00:02,000\n큐 수는 그대로\n",
  english:
    "1\n00:00:00,000 --> 00:00:01,000\nSecond current source\n\n2\n00:00:01,000 --> 00:00:02,000\nCue count unchanged\n",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function stageSmokeVideo() {
  const endpoint = `${baseUrl}/api/upload-request/video-staging`;
  const source = new TextEncoder().encode("smoke-video-in-two-chunks");
  const initResponse = await fetch(endpoint, {
    method: "POST",
    headers: { Origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({
      action: "init",
      videoFingerprint: `request-revision-${randomUUID()}`,
      file: {
        name: "smoke.mp4",
        type: "video/mp4",
        size: source.byteLength,
        lastModified: Date.now(),
      },
    }),
  });
  const init = await initResponse.json();
  if (!initResponse.ok || !init?.stage?.uploadId) {
    throw new Error(`Video staging init failed: ${JSON.stringify(init)}`);
  }
  const uploadId = init.stage.uploadId;
  createdStageIds.push(uploadId);

  let offset = 0;
  for (const chunk of [source.slice(0, 6), source.slice(6)]) {
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Origin: baseUrl,
        "content-type": "application/octet-stream",
        "x-upload-id": uploadId,
        "x-upload-offset": String(offset),
        "x-upload-chunk-size": String(chunk.byteLength),
      },
      body: chunk,
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) {
      throw new Error(`Video staging chunk failed: ${JSON.stringify(payload)}`);
    }
    offset += chunk.byteLength;
  }

  const finalizeResponse = await fetch(endpoint, {
    method: "POST",
    headers: { Origin: baseUrl, "content-type": "application/json" },
    body: JSON.stringify({ action: "finalize", uploadId }),
  });
  const finalized = await finalizeResponse.json();
  if (!finalizeResponse.ok || finalized?.stage?.status !== "complete") {
    throw new Error(`Video staging finalize failed: ${JSON.stringify(finalized)}`);
  }
  return uploadId;
}

function buildForm(
  description,
  koreanSrt,
  { defaultLanguage = "ko", defaultAudioLanguage = "ko" } = {},
) {
  const form = new FormData();
  form.append("stagedVideoId", stagedVideoId);
  form.append("contentKind", "longform");
  form.append("agentProjectSlug", slug);
  form.append("title", "codex-caption-revision-smoke");
  form.append("description", description);
  form.append("defaultLanguage", defaultLanguage);
  if (defaultAudioLanguage !== null) {
    form.append("defaultAudioLanguage", defaultAudioLanguage);
  }
  form.append("tags", "smoke,caption-revision");
  form.append("privacyStatus", "private");
  form.append(
    "subtitleTracks",
    JSON.stringify([{ id: "subtitle-ko", language: "ko", label: "Korean" }]),
  );
  form.append("targetLanguages", "[]");
  form.append("sourceFingerprint", `non-authoritative-${description}`);
  form.append("sourceSnapshot", JSON.stringify({ agentProjectSlug: slug }));
  form.append(
    "subtitleFile:subtitle-ko",
    new Blob([koreanSrt], { type: "application/x-subrip" }),
    "korean.srt",
  );
  return form;
}

function buildCinematicForm({ injectSubtitle = false } = {}) {
  const form = new FormData();
  form.append("stagedVideoId", stagedVideoId);
  form.append("contentKind", "cinematic");
  form.append("agentProjectSlug", cinematicSlug);
  form.append("title", "cinematic-no-caption-smoke");
  form.append("description", "User-confirmed cinematic video without manual captions");
  form.append("defaultLanguage", "ko");
  form.append("defaultAudioLanguage", "ja");
  form.append("tags", "smoke,cinematic");
  form.append("privacyStatus", "private");
  form.append("targetLanguages", "[]");
  form.append("sourceFingerprint", `cinematic-${randomUUID()}`);
  form.append("sourceSnapshot", JSON.stringify({ agentProjectSlug: cinematicSlug }));
  if (injectSubtitle) {
    form.append(
      "subtitleTracks",
      JSON.stringify([{ id: "subtitle-ko", language: "ko", label: "Korean" }]),
    );
    form.append(
      "subtitleFile:subtitle-ko",
      new Blob([revisionA.cleanKorean], { type: "application/x-subrip" }),
      "unexpected-korean.srt",
    );
  } else {
    form.append("subtitleTracks", "[]");
  }
  return form;
}

async function postRequest(form, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}/api/upload-request`, {
    method: "POST",
    headers: { Origin: baseUrl },
    body: form,
  });
  const payload = await response.json();
  if (response.status !== expectedStatus) {
    throw new Error(`Expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (expectedStatus !== 200) return payload;
  if (!payload?.ok || !payload?.request) {
    throw new Error(`Request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  if (path.isAbsolute(payload.request.requestDir)) {
    throw new Error("Server exposed an absolute request path in browser JSON.");
  }

  const requestDir = path.resolve(requestsRoot, payload.request.requestDir);
  if (!requestDir.startsWith(`${requestsRoot}${path.sep}`)) {
    throw new Error(`Unsafe request directory returned by server: ${payload.request.requestDir}`);
  }
  createdRequestDirs.push(requestDir);
  return { ...payload.request, requestDir };
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

try {
  stagedVideoId = await stageSmokeVideo();
  const directVideoForm = buildForm("reject-direct-video", revisionA.cleanKorean);
  directVideoForm.delete("stagedVideoId");
  directVideoForm.append("video", new Blob(["legacy-direct-video"], { type: "video/mp4" }), "legacy.mp4");
  const rejectedDirectVideo = await postRequest(directVideoForm, 400);
  if (rejectedDirectVideo?.error?.code !== "VIDEO_MUST_BE_STAGED") {
    throw new Error("Legacy direct-video multipart request was not rejected by the staging gate.");
  }
  const rejectedDefaultLanguage = await postRequest(
    buildForm("reject-default-language", revisionA.cleanKorean, {
      defaultLanguage: "en",
    }),
    400,
  );
  const rejectedDefaultAudioLanguage = await postRequest(
    buildForm("reject-default-audio-language", revisionA.cleanKorean, {
      defaultAudioLanguage: "en",
    }),
    400,
  );
  const rejectedMissingDefaultAudioLanguage = await postRequest(
    buildForm("reject-missing-default-audio-language", revisionA.cleanKorean, {
      defaultAudioLanguage: null,
    }),
    400,
  );
  for (const [field, rejected] of [
    ["defaultLanguage", rejectedDefaultLanguage],
    ["defaultAudioLanguage", rejectedDefaultAudioLanguage],
    ["defaultAudioLanguage", rejectedMissingDefaultAudioLanguage],
  ]) {
    if (
      rejected?.error?.code !== "VALIDATION_FAILED" ||
      rejected?.error?.detail?.required?.[field] !== "ko"
    ) {
      throw new Error(`Non-Korean ${field} was not rejected by the READY hard gate.`);
    }
  }

  const styledRevisionA = revisionA.cleanKorean.replace("첫 번째 원본", "<b>첫 번째 원본</b>");
  const first = await postRequest(buildForm("revision-a", styledRevisionA));
  const firstManifest = JSON.parse(
    await readFile(path.join(first.requestDir, "upload_request.json"), "utf8"),
  );
  const firstRevisionId = `caption-${sha256(revisionA.cleanKorean).slice(0, 24)}`;
  if (
    firstManifest.captionAuthority.revisionId !== firstRevisionId ||
    firstManifest.captionAuthority.cleanKorean.submittedSha256 !==
      sha256(revisionA.cleanKorean) ||
    !firstManifest.captionAuthority.cleanKorean.exactMatch ||
    firstManifest.captionAuthority.reviewedEnglish.status !== "pending_after_korean_upload" ||
    firstManifest.metadata.defaultLanguage !== "ko" ||
    firstManifest.metadata.defaultAudioLanguage !== "ko" ||
    firstManifest.metadata.privacyStatus !== "private" ||
    firstManifest.workflowPolicy?.stages?.[0] !== "ko_unlisted_upload" ||
    !firstManifest.metadata.description.includes(comfyReferralUrl) ||
    !firstManifest.metadata.description.includes(denoDiscordUrl)
  ) {
    throw new Error("Approved final KO revision or Korean-first language metadata was not persisted.");
  }
  for (const packagedPath of [
    firstManifest.captionAuthority.finalKorean.requestPath,
    firstManifest.captionAuthority.cleanKorean.requestPath,
  ]) {
    if (!(await exists(path.join(first.requestDir, packagedPath)))) {
      throw new Error(`Korean authority artifact was not packaged: ${packagedPath}`);
    }
  }
  const packagedClean = await readFile(
    path.join(first.requestDir, firstManifest.captionAuthority.cleanKorean.requestPath),
    "utf8",
  );
  if (packagedClean !== revisionA.cleanKorean || /<\/?b>/i.test(packagedClean)) {
    throw new Error("Style-tag-free clean Korean SRT was not packaged exactly.");
  }

  const second = await postRequest(buildForm("revision-b", revisionB.cleanKorean));
  const firstReady = await exists(path.join(first.requestDir, "READY"));
  const firstStale = await exists(path.join(first.requestDir, "STALE_CAPTION_REVISION"));
  const secondReady = await exists(path.join(second.requestDir, "READY"));
  if (firstReady || !firstStale || !secondReady) {
    throw new Error(
      `Stale marker mismatch: ${JSON.stringify({ firstReady, firstStale, secondReady })}`,
    );
  }

  const third = await postRequest(buildForm("revision-b-again", revisionB.cleanKorean));
  const secondSuperseded = await exists(path.join(second.requestDir, "SUPERSEDED"));
  const thirdReady = await exists(path.join(third.requestDir, "READY"));
  if (!secondSuperseded || !thirdReady) {
    throw new Error(
      `Same-revision marker mismatch: ${JSON.stringify({ secondSuperseded, thirdReady })}`,
    );
  }

  const rejectedCinematicSubtitle = await postRequest(
    buildCinematicForm({ injectSubtitle: true }),
    400,
  );
  if (rejectedCinematicSubtitle?.error?.code !== "VALIDATION_FAILED") {
    throw new Error("Cinematic no-caption request accepted an injected subtitle track.");
  }
  const cinematic = await postRequest(buildCinematicForm());
  const cinematicManifest = JSON.parse(
    await readFile(path.join(cinematic.requestDir, "upload_request.json"), "utf8"),
  );
  const cinematicReady = await readFile(path.join(cinematic.requestDir, "READY"), "utf8");
  if (
    cinematicManifest.contentKind !== "cinematic" ||
    cinematicManifest.metadata.defaultAudioLanguage !== "ja" ||
    cinematicManifest.uploadAuthorization.executionStrategy !== "video_then_metadata_localizations" ||
    !cinematicManifest.uploadAuthorization.scope.includes("metadata_localization_write") ||
    cinematicManifest.captionAuthority !== null ||
    cinematicManifest.captionPolicy?.mode !== "none" ||
    cinematicManifest.captionPolicy?.authority !==
      "user_declared_no_manual_captions_at_request_click" ||
    cinematicManifest.files.subtitles.length !== 0 ||
    cinematicManifest.workflowPolicy?.defaultManualCaptionLanguages?.length !== 0 ||
    cinematicManifest.workflowPolicy?.stages?.[0] !== "unlisted_video_upload" ||
    !cinematicManifest.metadata.description.includes(comfyReferralUrl) ||
    !cinematicManifest.metadata.description.includes(denoDiscordUrl) ||
    !/^captionMode=none$/m.test(cinematicReady)
  ) {
    throw new Error("Cinematic no-caption authority was not persisted exactly.");
  }

  console.log(
    JSON.stringify({
      ok: true,
      slug,
      rejectedNonKoreanVideoLanguage: true,
      rejectedNonKoreanAudioLanguage: true,
      rejectedMissingAudioLanguage: true,
      rejectedDirectVideoMultipart: true,
      validKoreanLanguageMetadataSaved: true,
      unlistedWorkflowStageNamesSaved: true,
      approvedFinalKoreanWithoutEnglishLock: true,
      styleTagsRemovedForCleanKorean: true,
      staleRevisionInvalidated: true,
      sameRevisionSupersededWithoutClientHint: true,
      cinematicNoCaptionAuthoritySaved: true,
      cinematicSubtitleInjectionRejected: true,
    }),
  );
} finally {
  await Promise.all([
    ...createdRequestDirs.map((requestDir) => rm(requestDir, { recursive: true, force: true })),
    ...createdStageIds.map(async (uploadId) => {
      await fetch(`${baseUrl}/api/upload-request/video-staging`, {
        method: "DELETE",
        headers: { Origin: baseUrl, "content-type": "application/json" },
        body: JSON.stringify({ uploadId }),
      }).catch(() => undefined);
    }),
  ]);
}
