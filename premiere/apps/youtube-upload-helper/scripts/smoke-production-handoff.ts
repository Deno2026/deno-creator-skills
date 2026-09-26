import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  prepareProductionHandoff,
  validateProductionHandoff,
} from "../src/lib/production-handoff";
import {
  comfyReferralUrl,
  configureDescriptionBlocks,
  discordUrl,
  ensurePermanentDescriptionLinks,
} from "../src/lib/description-policy";

// 설명 고정 링크는 channels.json 값이므로 스모크에서는 예시 값을 직접 넣는다.
configureDescriptionBlocks({
  comfyReferral: { url: "https://www.comfy.org/?via=example", ko: "☁️ ComfyUI 공식 홈페이지 (추천 링크)\nhttps://www.comfy.org/?via=example" },
  discord: { url: "https://discord.com/invite/example", ko: "💬 Discord 채널\nhttps://discord.com/invite/example" },
});
const COMFY_REFERRAL_URL = comfyReferralUrl();
const DENO_DISCORD_URL = discordUrl();

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath: string, value: unknown) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
const sponsorDescription = ensurePermanentDescriptionLinks(
  `협찬 설명\n\n☁️ ComfyUI 공식 홈페이지 (Deno 추천 링크)\n${COMFY_REFERRAL_URL}`,
  { includeComfyReferral: false },
);
assert.equal(sponsorDescription.includes(COMFY_REFERRAL_URL), false);
assert.equal(sponsorDescription.includes(DENO_DISCORD_URL), true);

const sandbox = await mkdtemp(path.join(os.tmpdir(), "deno-production-handoff-smoke-"));
const productionRoot = path.join(sandbox, "source");
const runtimeRoot = path.join(sandbox, "runtime");
const slug = "handoff-smoke";
const productionDir = path.join(productionRoot, "productions", slug);
const captionsDir = path.join(productionDir, "captions");
const deliveryDir = path.join(productionDir, "delivery");
const publishingDir = path.join(productionDir, "publishing");
const renderDir = path.join(productionRoot, "renders", slug);

process.env.DENO_PRODUCTION_ROOT = productionRoot;
process.env.DENO_UPLOAD_HELPER_RUNTIME_ROOT = runtimeRoot;

try {
  await Promise.all(
    [captionsDir, deliveryDir, publishingDir, renderDir, runtimeRoot].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );
  const videoPath = path.join(renderDir, "master.mp4");
  const captionPath = path.join(captionsDir, "final-ko.srt");
  const deliveryPath = path.join(deliveryDir, "master-manifest.json");
  const handoffPath = path.join(publishingDir, "handoff.json");
  const metadataPath = path.join(publishingDir, "metadata-candidates.json");
  const videoBytes = Buffer.from("exact-master-video");
  const captionText = "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요.\n";
  await writeFile(videoPath, videoBytes);
  await writeFile(captionPath, captionText, "utf8");
  const captionSha = sha256(captionText);
  const timelineSha = sha256("1|00:00:00,000|00:00:01,000|");
  const delivery = {
    schemaVersion: 1,
    production: slug,
    createdAt: "2026-08-31T00:00:00.000Z",
    ready: true,
    revisions: {
      edit: "edit-r1",
      audio: "audio-r1",
      motion: "motion-r1",
      captions: "caption-r1",
      render: "render-r1",
    },
    video: {
      path: videoPath,
      sha256: sha256(videoBytes),
      bytes: videoBytes.length,
      durationSeconds: 1,
      captionEmbedding: "sidecar",
      codec: "test",
      loudnessReport: null,
    },
    captions: {
      finalKoreanPath: captionPath,
      sha256: captionSha,
      timelineSha256: timelineSha,
      cueCount: 1,
      syncReport: null,
    },
  };
  await writeJson(deliveryPath, delivery);
  const metadataDocument = {
    schemaVersion: 1,
    slug,
    authority: "agent_candidates_for_user_review",
    metadata: {
      title: "기존 자막도우미 metadata schema",
      description: "본문",
      tags: ["ComfyUI"],
      titleCandidates: ["제목 1", "제목 2", "제목 3"],
      descriptionCandidates: ["설명 1", "설명 2", "설명 3"],
      chapterCandidates: ["00:00 균형형", "00:00 상세형", "00:00 확장형"],
      campaign: {
        name: "제휴 링크 금지 캠페인",
        noAffiliateLinks: true,
        brandApprovalRequired: true,
        descriptionChecklist: ["전용 링크만 사용"],
        manualChecklist: [],
      },
    },
    notes: { finalAuthority: "user_helper_completion" },
  };
  await writeJson(metadataPath, metadataDocument);
  const deliverySha = sha256(await readFile(deliveryPath));
  const handoff = {
    schemaVersion: 1,
    production: slug,
    createdAt: "2026-08-31T01:00:00.000Z",
    readyForHelper: true,
    deliveryManifest: { path: deliveryPath, sha256: deliverySha },
    video: {
      path: videoPath,
      sha256: delivery.video.sha256,
      bytes: videoBytes.length,
      durationSeconds: 1,
    },
    captions: {
      finalKoreanPath: captionPath,
      sha256: captionSha,
      timelineSha256: timelineSha,
      cueCount: 1,
      revision: "caption-r1",
    },
    thumbnail: null,
    metadata: { path: metadataPath, sha256: sha256(await readFile(metadataPath)) },
    approvals: {
      helperRequestSaved: false,
      youtubeWriteAuthorized: false,
      publicVisibilityAuthorized: false,
    },
  };
  await writeJson(handoffPath, handoff);

  const validated = await validateProductionHandoff(slug);
  assert.equal(validated.video.sha256, delivery.video.sha256);
  assert.equal(validated.captions.sha256, captionSha);
  const prepared = await prepareProductionHandoff(slug);
  assert.equal(prepared.video.stage.status, "complete");
  assert.match(prepared.video.stage.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.ok(
    prepared.video.stage.materializationMode === "hardlink" ||
      prepared.video.stage.materializationMode === "copy",
  );
  assert.equal(prepared.video.stage.size, videoBytes.length);
  assert.equal(prepared.caption.sha256, captionSha);
  assert.equal(prepared.metadata?.title, metadataDocument.metadata.title);
  assert.deepEqual(
    prepared.metadata?.chapterCandidates,
    metadataDocument.metadata.chapterCandidates,
  );
  const preparedCampaign = prepared.metadata?.campaign as
    | { noAffiliateLinks?: boolean }
    | undefined;
  assert.equal(preparedCampaign?.noAffiliateLinks, true);
  assert.equal(
    (preparedCampaign as { brandApprovalRequired?: boolean } | undefined)
      ?.brandApprovalRequired,
    true,
  );

  await writeFile(captionPath, `${captionText}\n조작`, "utf8");
  await assert.rejects(validateProductionHandoff(slug), /FINAL_KOREAN_SHA256_MISMATCH/);
  await writeFile(captionPath, captionText, "utf8");

  await writeFile(deliveryPath, `${JSON.stringify(delivery)}\n `, "utf8");
  await assert.rejects(validateProductionHandoff(slug), /DELIVERY_MANIFEST_SHA256_MISMATCH/);
  await writeJson(deliveryPath, delivery);

  const outsidePath = path.join(productionRoot, "outside-master.mp4");
  await writeFile(outsidePath, videoBytes);
  await writeJson(handoffPath, {
    ...handoff,
    video: { ...handoff.video, path: outsidePath },
    deliveryManifest: {
      ...handoff.deliveryManifest,
      sha256: sha256(await readFile(deliveryPath)),
    },
  });
  await assert.rejects(validateProductionHandoff(slug), /MASTER_VIDEO_OUTSIDE_ALLOWED_ROOT/);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      exactMasterAndCaptionReverified: true,
      hardlinkOrCopyMaterializationVerified: true,
      tamperedCaptionBlocked: true,
      staleDeliveryBlocked: true,
      outsideProductionPathBlocked: true,
      legacyMetadataSchemaUnwrapped: true,
      oauthOrYoutubeWrites: 0,
    })}\n`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
