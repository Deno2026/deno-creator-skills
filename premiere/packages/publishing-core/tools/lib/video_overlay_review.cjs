const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { createReadStream } = require("node:fs");
const {
  access,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} = require("node:fs/promises");
const path = require("node:path");

const REVIEW_FILE_NAME = "video_overlay_review.json";
const SAMPLE_MANIFEST_FILE_NAME = "sample_manifest.json";
const REVIEW_RULE = "at_least_one_sample_shows_deno_fixed_tutorial_frame";

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex").toUpperCase();
}

function normalizedHash(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function runMediaTool(command, args, label, timeoutMs = 60000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`${label} timed out after ${timeoutMs} ms`);
    }
    throw new Error(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}): ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  return result.stdout;
}

function validatePolicy(policy) {
  if (!policy || policy.schemaVersion !== 1 || policy.enabled !== true) {
    throw new Error("Video overlay policy is missing, disabled, or unsupported");
  }
  if (policy.reviewRule !== REVIEW_RULE) {
    throw new Error(`Unsupported video overlay review rule: ${policy.reviewRule ?? "missing"}`);
  }
  if (
    !Array.isArray(policy.sampleFractions) ||
    policy.sampleFractions.length !== 9 ||
    policy.sampleFractions.some(
      (fraction, index) =>
        typeof fraction !== "number" ||
        fraction <= 0 ||
        fraction >= 1 ||
        (index > 0 && fraction <= policy.sampleFractions[index - 1]),
    )
  ) {
    throw new Error(
      "Video overlay policy must define exactly nine strictly increasing fractions between 0 and 1",
    );
  }
  if (
    !Array.isArray(policy.referenceOverlays) ||
    policy.referenceOverlays.length === 0 ||
    policy.referenceOverlays.some(
      (reference) =>
        !reference ||
        typeof reference.path !== "string" ||
        !reference.path.trim() ||
        !normalizedHash(reference.sha256),
    )
  ) {
    throw new Error("Video overlay policy requires at least one SHA-256-locked reference overlay");
  }
  return policy;
}

async function validateReferenceOverlays(policy) {
  const references = [];
  for (const reference of policy.referenceOverlays) {
    const referencePath = path.resolve(reference.path);
    await access(referencePath);
    const referenceStat = await stat(referencePath);
    if (!referenceStat.isFile()) {
      throw new Error(`Overlay reference is not a file: ${referencePath}`);
    }
    const actualSha256 = await sha256File(referencePath);
    if (actualSha256 !== normalizedHash(reference.sha256)) {
      throw new Error(`Overlay reference SHA-256 mismatch: ${referencePath}`);
    }
    references.push({
      path: referencePath,
      fileName: path.basename(referencePath),
      byteSize: referenceStat.size,
      sha256: actualSha256,
      role: reference.role ?? "fixed_tutorial_frame_reference",
    });
  }
  return references;
}

function requestIdentity(manifest, videoStat) {
  const requestId = String(manifest.requestId ?? "").trim();
  const sourceFingerprint = String(
    manifest.sourceOfTruth?.sourceFingerprint ??
      manifest.sourceOfTruth?.sourceSnapshot?.sourceFingerprint ??
      "",
  ).trim();
  const videoSha256 = normalizedHash(manifest.files?.video?.sha256);
  if (!requestId || !sourceFingerprint || !videoSha256) {
    throw new Error("Helper request lacks requestId, sourceFingerprint, or video SHA-256");
  }
  if (Number(manifest.files?.video?.size) !== videoStat.size) {
    throw new Error("Helper request video size changed before overlay review");
  }
  return {
    requestId,
    slug: String(manifest.agentProject?.slug ?? manifest.slug ?? "").trim(),
    sourceFingerprint,
    videoSha256,
    videoByteSize: videoStat.size,
  };
}

function sampleWorkspace(verificationDir, videoSha256) {
  const root = path.resolve(verificationDir);
  const sampleDir = path.join(root, "video-overlay", videoSha256.slice(0, 16));
  const relative = path.relative(root, sampleDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe video overlay sample directory: ${sampleDir}`);
  }
  return {
    sampleDir,
    sampleManifestPath: path.join(sampleDir, SAMPLE_MANIFEST_FILE_NAME),
    contactSheetPath: path.join(sampleDir, "contact-sheet-3x3.png"),
  };
}

async function readReusableSampleManifest(sampleManifestPath, identity, policySha256) {
  const manifest = await readJson(sampleManifestPath).catch(() => null);
  if (
    !manifest ||
    manifest.schemaVersion !== 1 ||
    manifest.reviewRule !== REVIEW_RULE ||
    normalizedHash(manifest.policySha256) !== normalizedHash(policySha256) ||
    manifest.requestId !== identity.requestId ||
    manifest.sourceFingerprint !== identity.sourceFingerprint ||
    normalizedHash(manifest.video?.sha256) !== identity.videoSha256 ||
    manifest.video?.byteSize !== identity.videoByteSize ||
    !Array.isArray(manifest.samples) ||
    manifest.samples.length !== 9
  ) {
    return null;
  }
  const artifacts = [
    ...manifest.samples.map((sample) => ({ path: sample.path, sha256: sample.sha256 })),
    manifest.contactSheet,
  ];
  for (const artifact of artifacts) {
    if (!artifact?.path || !normalizedHash(artifact.sha256)) return null;
    const actualSha256 = await sha256File(artifact.path).catch(() => "");
    if (actualSha256 !== normalizedHash(artifact.sha256)) return null;
  }
  return manifest;
}

function probeVideo(videoPath) {
  const stdout = runMediaTool(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      videoPath,
    ],
    "ffprobe video overlay preflight",
  );
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams?.[0];
  const durationSeconds = Number(parsed.format?.duration);
  if (
    !stream ||
    !Number.isInteger(stream.width) ||
    stream.width <= 0 ||
    !Number.isInteger(stream.height) ||
    stream.height <= 0 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    throw new Error("ffprobe returned no usable video dimensions or duration");
  }
  return {
    width: stream.width,
    height: stream.height,
    durationSeconds,
  };
}

async function buildContactSheet(sampleDir, contactSheetPath) {
  const inputPattern = path.join(sampleDir, "sample-%02d.png");
  runMediaTool(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-framerate",
      "1",
      "-start_number",
      "1",
      "-i",
      inputPattern,
      "-vf",
      "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,tile=3x3:nb_frames=9:padding=4:margin=4",
      "-frames:v",
      "1",
      "-y",
      contactSheetPath,
    ],
    "ffmpeg video overlay contact sheet",
  );
  return {
    path: contactSheetPath,
    sha256: await sha256File(contactSheetPath),
  };
}

async function prepareVideoOverlaySamples({
  requestDir,
  manifest,
  videoPath,
  videoStat,
  verificationDir,
  policyPath,
}) {
  const policy = validatePolicy(await readJson(policyPath));
  const policySha256 = await sha256File(policyPath);
  const referenceOverlays = await validateReferenceOverlays(policy);
  const identity = requestIdentity(manifest, videoStat);
  const workspace = sampleWorkspace(verificationDir, identity.videoSha256);
  const reusable = await readReusableSampleManifest(
    workspace.sampleManifestPath,
    identity,
    policySha256,
  );
  if (reusable) {
    return {
      ...workspace,
      manifest: reusable,
      manifestSha256: await sha256File(workspace.sampleManifestPath),
      reused: true,
    };
  }

  const probe = probeVideo(videoPath);
  await mkdir(workspace.sampleDir, { recursive: true });
  const samples = [];
  for (let index = 0; index < policy.sampleFractions.length; index += 1) {
    const fraction = policy.sampleFractions[index];
    const timestampSeconds = Math.min(
      Math.max(probe.durationSeconds * fraction, 0),
      Math.max(probe.durationSeconds - 0.05, 0),
    );
    const samplePath = path.join(
      workspace.sampleDir,
      `sample-${String(index + 1).padStart(2, "0")}.png`,
    );
    runMediaTool(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        timestampSeconds.toFixed(3),
        "-i",
        videoPath,
        "-frames:v",
        "1",
        "-vf",
        "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black",
        "-compression_level",
        "3",
        "-y",
        samplePath,
      ],
      `ffmpeg video overlay sample ${index + 1}`,
    );
    samples.push({
      index: index + 1,
      fraction,
      timestampSeconds: Number(timestampSeconds.toFixed(3)),
      path: samplePath,
      sha256: await sha256File(samplePath),
    });
  }

  const contactSheet = await buildContactSheet(workspace.sampleDir, workspace.contactSheetPath);
  const sampleManifest = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    requestId: identity.requestId,
    slug: identity.slug,
    sourceFingerprint: identity.sourceFingerprint,
    reviewRule: REVIEW_RULE,
    policySha256,
    visualSignature: [
      "large top-left D logo from the reference overlay",
      "full-width top IMAGE VIDEO AGENTS WORK navigation",
      "dark patterned top frame",
      "dark patterned bottom frame",
      "small in-app D icons, favicons, node badges, watermarks, subtitles, and partial logos do not qualify",
    ],
    video: {
      path: path.resolve(videoPath),
      byteSize: identity.videoByteSize,
      sha256: identity.videoSha256,
      durationSeconds: Number(probe.durationSeconds.toFixed(3)),
      width: probe.width,
      height: probe.height,
    },
    referenceOverlays,
    samples,
    contactSheet,
  };
  await writeJsonAtomic(workspace.sampleManifestPath, sampleManifest);
  return {
    ...workspace,
    manifest: sampleManifest,
    manifestSha256: await sha256File(workspace.sampleManifestPath),
    reused: false,
  };
}

async function verifyPreparedSampleArtifacts(prepared) {
  const actualManifestSha256 = await sha256File(prepared.sampleManifestPath);
  if (actualManifestSha256 !== normalizedHash(prepared.manifestSha256)) {
    throw new Error("Video overlay sample manifest changed after preparation");
  }
  for (const sample of prepared.manifest.samples) {
    const actualSha256 = await sha256File(sample.path);
    if (actualSha256 !== normalizedHash(sample.sha256)) {
      throw new Error(`Video overlay sample changed after preparation: ${sample.index}`);
    }
  }
  const actualContactSheetSha256 = await sha256File(prepared.manifest.contactSheet.path);
  if (actualContactSheetSha256 !== normalizedHash(prepared.manifest.contactSheet.sha256)) {
    throw new Error("Video overlay contact sheet changed after preparation");
  }
}

async function verifyVideoOverlayReview({
  requestDir,
  manifest,
  videoStat,
  prepared,
}) {
  const identity = requestIdentity(manifest, videoStat);
  await verifyPreparedSampleArtifacts(prepared);
  const reviewPath = path.join(requestDir, REVIEW_FILE_NAME);
  const review = await readJson(reviewPath).catch(() => null);
  if (!review) {
    throw new Error(
      `VIDEO_OVERLAY_REVIEW_REQUIRED contactSheet=${prepared.contactSheetPath} sampleManifest=${prepared.sampleManifestPath}`,
    );
  }
  const identityMatches =
    review.schemaVersion === 1 &&
    review.reviewRule === REVIEW_RULE &&
    review.requestId === identity.requestId &&
    review.sourceFingerprint === identity.sourceFingerprint &&
    normalizedHash(review.videoSha256) === identity.videoSha256 &&
    review.videoByteSize === identity.videoByteSize &&
    normalizedHash(review.sampleManifestSha256) === normalizedHash(prepared.manifestSha256);
  if (!identityMatches) {
    throw new Error("VIDEO_OVERLAY_REVIEW_STALE request, video, or sample identity changed");
  }
  if (review.decision === "not_applicable_non_tutorial") {
    if (review.allSamplesReviewed !== true || review.atLeastOneOverlayVisible !== false ||
        review.fullSignatureConfirmed !== false || !Array.isArray(review.evidenceSampleIndexes) ||
        review.evidenceSampleIndexes.length !== 0 ||
        typeof review.nonTutorialReason !== "string" || !review.nonTutorialReason.trim() ||
        typeof review.userScopeEvidence !== "string" || !review.userScopeEvidence.trim()) {
      throw new Error("VIDEO_OVERLAY_REVIEW_INVALID non-tutorial scope evidence is missing");
    }
    return {path: reviewPath, review, evidenceSamples: []};
  }
  if (review.decision === "missing") {
    throw new Error(
      `VIDEO_OVERLAY_MISSING all ${prepared.manifest.samples.length} samples were reviewed without the DENO fixed tutorial frame`,
    );
  }
  if (
    review.decision !== "applied" ||
    review.atLeastOneOverlayVisible !== true ||
    review.allSamplesReviewed !== true ||
    review.fullSignatureConfirmed !== true ||
    !Array.isArray(review.evidenceSampleIndexes) ||
    review.evidenceSampleIndexes.length === 0
  ) {
    throw new Error("VIDEO_OVERLAY_REVIEW_INVALID applied evidence is missing");
  }
  const samplesByIndex = new Map(
    prepared.manifest.samples.map((sample) => [sample.index, sample]),
  );
  for (const sampleIndex of review.evidenceSampleIndexes) {
    if (!samplesByIndex.has(sampleIndex)) {
      throw new Error(`VIDEO_OVERLAY_REVIEW_INVALID unknown evidence sample ${sampleIndex}`);
    }
  }
  return {
    path: reviewPath,
    review,
    evidenceSamples: review.evidenceSampleIndexes.map((sampleIndex) =>
      samplesByIndex.get(sampleIndex),
    ),
  };
}

async function recordVideoOverlayReview({
  requestDir,
  manifest,
  videoStat,
  prepared,
  decision,
  evidenceSampleIndexes,
  allSamplesReviewed,
  fullSignatureConfirmed,
  nonTutorialReason = "",
  userScopeEvidence = "",
}) {
  const identity = requestIdentity(manifest, videoStat);
  await verifyPreparedSampleArtifacts(prepared);
  if (!["applied", "missing", "not_applicable_non_tutorial"].includes(decision)) {
    throw new Error(`Unsupported video overlay decision: ${decision}`);
  }
  const uniqueEvidence = [...new Set(evidenceSampleIndexes)].sort((left, right) => left - right);
  const validIndexes = new Set(prepared.manifest.samples.map((sample) => sample.index));
  if (uniqueEvidence.some((sampleIndex) => !validIndexes.has(sampleIndex))) {
    throw new Error("Evidence sample index is outside the prepared sample set");
  }
  if (decision === "applied" && uniqueEvidence.length === 0) {
    throw new Error("Applied overlay review requires at least one visible evidence sample");
  }
  if (decision === "applied" && allSamplesReviewed !== true) {
    throw new Error("Applied overlay review requires all nine samples to be reviewed");
  }
  if (decision === "applied" && fullSignatureConfirmed !== true) {
    throw new Error(
      "Applied overlay review requires the complete fixed-frame signature in the same evidence sample",
    );
  }
  if (decision === "missing" && (uniqueEvidence.length > 0 || allSamplesReviewed !== true)) {
    throw new Error("Missing overlay review requires all samples reviewed and no evidence sample");
  }
  if (decision === "not_applicable_non_tutorial" &&
      (allSamplesReviewed !== true || uniqueEvidence.length !== 0 || fullSignatureConfirmed === true ||
       typeof nonTutorialReason !== "string" || !nonTutorialReason.trim() ||
       typeof userScopeEvidence !== "string" || !userScopeEvidence.trim())) {
    throw new Error("Non-tutorial scope requires all samples reviewed and explicit user scope evidence");
  }
  const review = {
    ...(decision === "not_applicable_non_tutorial" ? {nonTutorialReason, userScopeEvidence} : {}),
    schemaVersion: 1,
    reviewedAt: new Date().toISOString(),
    reviewer: "codex_visual_review",
    reviewRule: REVIEW_RULE,
    requestId: identity.requestId,
    slug: identity.slug,
    sourceFingerprint: identity.sourceFingerprint,
    videoSha256: identity.videoSha256,
    videoByteSize: identity.videoByteSize,
    sampleManifestPath: prepared.sampleManifestPath,
    sampleManifestSha256: normalizedHash(prepared.manifestSha256),
    contactSheetPath: prepared.contactSheetPath,
    decision,
    atLeastOneOverlayVisible: decision === "applied",
    evidenceSampleIndexes: uniqueEvidence,
    allSamplesReviewed: decision === "missing" ? true : allSamplesReviewed === true,
    fullSignatureConfirmed: decision === "applied" && fullSignatureConfirmed === true,
  };
  const reviewPath = path.join(requestDir, REVIEW_FILE_NAME);
  await writeJsonAtomic(reviewPath, review);
  return { path: reviewPath, review };
}

module.exports = {
  REVIEW_FILE_NAME,
  REVIEW_RULE,
  prepareVideoOverlaySamples,
  recordVideoOverlayReview,
  sha256File,
  verifyVideoOverlayReview,
};
