import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { getDescriptionBlocks, resolveUploadChannel } from "@deno/runtime-paths";

import {
  defaultUploadDraft,
  normalizeUploadDraft,
  uploadDraftForChannel,
  type UploadPreset,
} from "@/lib/upload-preset-types";
import { configureDescriptionBlocks } from "@/lib/description-policy";
import {
  getActiveChannelId,
  getUploadPresetStorePath,
  loadUploadPresetStore,
  saveUploadPresetStore,
  uploadPresetStoreExists,
} from "@/lib/youtube-storage";

export const runtime = "nodejs";

function sortPresets(presets: UploadPreset[]) {
  return [...presets].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

// 프리셋은 채널별로 저장한다. 한 요청 안에서는 시작 시점의 선택 채널 하나만 쓴다.
// 시작 프리셋은 channels.json의 채널 기본값(uploadDefaults)으로 만든다 — 채널 이름·링크를 코드에 두지 않는다.
function createStarterPresets(channelId: string) {
  const now = Date.now();
  const channel = resolveUploadChannel(channelId);
  const blocks = configureDescriptionBlocks(getDescriptionBlocks());
  const defaults = (channel.uploadDefaults ?? {}) as { presetName?: unknown };
  const presetName = typeof defaults.presetName === "string" && defaults.presetName.trim() ? defaults.presetName.trim() : "기본 롱폼";
  return sortPresets([
    {
      id: randomUUID(),
      name: presetName,
      draft: normalizeUploadDraft(uploadDraftForChannel(channel, blocks)),
      updatedAt: new Date(now).toISOString(),
    },
  ]);
}

export async function GET() {
  const channelId = await getActiveChannelId();
  const store = await loadUploadPresetStore(channelId);
  const storeExists = await uploadPresetStoreExists(channelId);

  if (!storeExists && store.presets.length === 0) {
    const starterPresets = createStarterPresets(channelId);

    await saveUploadPresetStore(
      {
        presets: starterPresets,
      },
      channelId,
    );

    return NextResponse.json({
      channel: channelId,
      presets: starterPresets,
      storagePath: await getUploadPresetStorePath(channelId),
    });
  }

  return NextResponse.json({
    channel: channelId,
    presets: sortPresets(store.presets),
    storagePath: await getUploadPresetStorePath(channelId),
  });
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    id?: string;
    name?: string;
    draft?: Partial<typeof defaultUploadDraft>;
  };

  const name = body.name?.trim();

  if (!name) {
    return NextResponse.json(
      { error: "프리셋 이름을 입력해주세요." },
      { status: 400 },
    );
  }

  const channelId = await getActiveChannelId();
  const store = await loadUploadPresetStore(channelId);
  const now = new Date().toISOString();
  const nextPreset: UploadPreset = {
    id: body.id?.trim() || randomUUID(),
    name,
    draft: normalizeUploadDraft(body.draft),
    updatedAt: now,
  };

  const presets = store.presets.some((preset) => preset.id === nextPreset.id)
    ? store.presets.map((preset) =>
        preset.id === nextPreset.id ? nextPreset : preset,
      )
    : [nextPreset, ...store.presets];

  const sortedPresets = sortPresets(presets);

  await saveUploadPresetStore(
    {
      presets: sortedPresets,
    },
    channelId,
  );

  return NextResponse.json({
    channel: channelId,
    preset: nextPreset,
    presets: sortedPresets,
    storagePath: await getUploadPresetStorePath(channelId),
  });
}

export async function DELETE(request: Request) {
  const body = (await request.json()) as { id?: string };
  const id = body.id?.trim();

  if (!id) {
    return NextResponse.json(
      { error: "삭제할 프리셋을 찾지 못했습니다." },
      { status: 400 },
    );
  }

  const channelId = await getActiveChannelId();
  const store = await loadUploadPresetStore(channelId);
  const nextPresets = sortPresets(
    store.presets.filter((preset) => preset.id !== id),
  );

  await saveUploadPresetStore(
    {
      presets: nextPresets,
    },
    channelId,
  );

  return NextResponse.json({
    channel: channelId,
    presets: nextPresets,
    storagePath: await getUploadPresetStorePath(channelId),
  });
}
