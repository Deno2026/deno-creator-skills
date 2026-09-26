import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

import { loadLlmSettings } from "@/lib/llm/settings";
import type { LlmProvider } from "@/lib/llm/types";

export const runtime = "nodejs";
export const maxDuration = 30;

type ModelListItem = { id: string; label?: string };

type ModelsRequestBody = {
  /**
   * 호출 시점에 사용자가 입력 중인 설정으로 덮어쓰기 가능.
   * 비어 있으면 저장된 설정을 사용한다.
   */
  provider?: LlmProvider;
  apiKey?: string;
  baseUrl?: string;
};

function normalizeOllamaBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

function isLoopbackHttpUrl(raw: string) {
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  let body: ModelsRequestBody;

  try {
    body = (await request.json()) as ModelsRequestBody;
  } catch {
    body = {};
  }

  const stored = await loadLlmSettings();
  const provider: LlmProvider = body.provider ?? stored.provider;

  try {
    if (provider === "anthropic") {
      const apiKey = body.apiKey?.trim() || stored.anthropic.apiKey;

      if (!apiKey) {
        return NextResponse.json(
          { ok: false, provider, error: "Anthropic API 키가 입력되지 않았습니다." },
          { status: 400 },
        );
      }

      const client = new Anthropic({ apiKey });
      const list = await client.models.list({ limit: 50 });
      const models: ModelListItem[] = list.data.map((entry) => ({
        id: entry.id,
        label: entry.display_name,
      }));

      return NextResponse.json({ ok: true, provider, models });
    }

    if (provider === "ollama") {
      const requestedBaseUrl = body.baseUrl?.trim();
      const baseUrl = normalizeOllamaBaseUrl(
        requestedBaseUrl || stored.ollama.baseUrl,
      );

      if (!baseUrl) {
        return NextResponse.json(
          { ok: false, provider, error: "Ollama 서버 주소가 입력되지 않았습니다." },
          { status: 400 },
        );
      }

      if (
        requestedBaseUrl &&
        normalizeOllamaBaseUrl(requestedBaseUrl) !== normalizeOllamaBaseUrl(stored.ollama.baseUrl) &&
        !isLoopbackHttpUrl(baseUrl)
      ) {
        return NextResponse.json(
          { ok: false, provider, error: "Ollama 모델 조회는 로컬 주소만 허용합니다." },
          { status: 400 },
        );
      }

      const response = await fetch(`${baseUrl}/api/tags`, {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
        );
      }

      const data = (await response.json()) as {
        models?: Array<{
          name: string;
          details?: { family?: string; parameter_size?: string; quantization_level?: string };
        }>;
      };

      const models: ModelListItem[] = (data.models ?? []).map((entry) => ({
        id: entry.name,
        label: [entry.details?.parameter_size, entry.details?.quantization_level]
          .filter(Boolean)
          .join(" "),
      }));

      models.sort((a, b) => a.id.localeCompare(b.id));

      return NextResponse.json({ ok: true, provider, models });
    }

    if (provider === "openai-compat") {
      const storedBaseUrl = normalizeBaseUrl(stored.openaiCompat.baseUrl);
      const requestedBaseUrl = body.baseUrl?.trim();
      const baseUrl = normalizeBaseUrl(requestedBaseUrl || storedBaseUrl);
      const providedApiKey =
        typeof body.apiKey === "string" ? body.apiKey.trim() : undefined;
      const sameAsStored = baseUrl === storedBaseUrl;
      const apiKey = providedApiKey ?? (sameAsStored ? stored.openaiCompat.apiKey ?? "" : "");

      if (!baseUrl) {
        return NextResponse.json(
          { ok: false, provider, error: "서버 주소가 입력되지 않았습니다." },
          { status: 400 },
        );
      }

      if (!sameAsStored && providedApiKey === undefined && !isLoopbackHttpUrl(baseUrl)) {
        return NextResponse.json(
          {
            ok: false,
            provider,
            error: "새 서버 주소로 모델을 조회하려면 해당 요청에서 API 키를 직접 입력해야 합니다.",
          },
          { status: 400 },
        );
      }

      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }

      const response = await fetch(`${baseUrl}/models`, { headers });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
          `${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
        );
      }

      const data = (await response.json()) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };

      const models: ModelListItem[] = (data.data ?? []).map((entry) => ({
        id: entry.id,
        label: entry.owned_by,
      }));

      // Ollama·LM Studio 등은 모델 수가 적고 정렬이 임의라 alphabetical 정렬해서 찾기 쉽게.
      models.sort((a, b) => a.id.localeCompare(b.id));

      return NextResponse.json({ ok: true, provider, models });
    }

    return NextResponse.json(
      { ok: false, provider, error: `지원하지 않는 공급자: ${provider}` },
      { status: 400 },
    );
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "모델 목록을 가져오지 못했습니다.";
    return NextResponse.json(
      { ok: false, provider, error: detail },
      { status: 500 },
    );
  }
}
