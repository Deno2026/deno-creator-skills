import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { getStorageRoot } from "@/lib/youtube-storage";

import type { LlmSettings } from "./types";

const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: "anthropic",
  anthropic: {
    apiKey: "",
    model: "claude-opus-4-7",
  },
  openaiCompat: {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    model: "gemma4:31b-it-q4_K_M",
    numCtx: 40960,
    keepAlive: "30m",
    temperature: 0.45,
  },
  ollamaCheckComfyui: true,
  autoSuggestMetadata: true,
  targetLanguages: ["en", "ja", "zh-Hans", "ru", "es-419", "id", "pt-BR", "de", "fr"],
};

function getLlmSettingsPath() {
  return path.join(getStorageRoot(), "llm-settings.json");
}

export function normalizeLlmSettings(
  partial: Partial<LlmSettings> | null | undefined,
): LlmSettings {
  if (!partial) {
    return DEFAULT_LLM_SETTINGS;
  }

  const provider: LlmSettings["provider"] =
    partial.provider === "openai-compat"
      ? "openai-compat"
      : partial.provider === "ollama"
        ? "ollama"
        : DEFAULT_LLM_SETTINGS.provider;

  return {
    provider,
    anthropic: {
      apiKey:
        typeof partial.anthropic?.apiKey === "string"
          ? partial.anthropic.apiKey
          : DEFAULT_LLM_SETTINGS.anthropic.apiKey,
      model:
        typeof partial.anthropic?.model === "string" && partial.anthropic.model.trim()
          ? partial.anthropic.model
          : DEFAULT_LLM_SETTINGS.anthropic.model,
    },
    openaiCompat: {
      baseUrl:
        typeof partial.openaiCompat?.baseUrl === "string" && partial.openaiCompat.baseUrl.trim()
          ? partial.openaiCompat.baseUrl
          : DEFAULT_LLM_SETTINGS.openaiCompat.baseUrl,
      apiKey:
        typeof partial.openaiCompat?.apiKey === "string"
          ? partial.openaiCompat.apiKey
          : DEFAULT_LLM_SETTINGS.openaiCompat.apiKey,
      model:
        typeof partial.openaiCompat?.model === "string" && partial.openaiCompat.model.trim()
          ? partial.openaiCompat.model
          : DEFAULT_LLM_SETTINGS.openaiCompat.model,
    },
    ollama: {
      baseUrl:
        typeof partial.ollama?.baseUrl === "string" && partial.ollama.baseUrl.trim()
          ? partial.ollama.baseUrl
          : DEFAULT_LLM_SETTINGS.ollama.baseUrl,
      model:
        typeof partial.ollama?.model === "string" && partial.ollama.model.trim()
          ? partial.ollama.model
          : DEFAULT_LLM_SETTINGS.ollama.model,
      numCtx:
        typeof partial.ollama?.numCtx === "number" && partial.ollama.numCtx > 0
          ? partial.ollama.numCtx
          : DEFAULT_LLM_SETTINGS.ollama.numCtx,
      keepAlive:
        typeof partial.ollama?.keepAlive === "string" && partial.ollama.keepAlive.trim()
          ? partial.ollama.keepAlive
          : DEFAULT_LLM_SETTINGS.ollama.keepAlive,
      temperature:
        typeof partial.ollama?.temperature === "number"
          ? partial.ollama.temperature
          : DEFAULT_LLM_SETTINGS.ollama.temperature,
    },
    ollamaCheckComfyui:
      typeof partial.ollamaCheckComfyui === "boolean"
        ? partial.ollamaCheckComfyui
        : DEFAULT_LLM_SETTINGS.ollamaCheckComfyui,
    autoSuggestMetadata:
      typeof partial.autoSuggestMetadata === "boolean"
        ? partial.autoSuggestMetadata
        : DEFAULT_LLM_SETTINGS.autoSuggestMetadata,
    targetLanguages:
      Array.isArray(partial.targetLanguages) &&
      partial.targetLanguages.every((code) => typeof code === "string")
        ? partial.targetLanguages
        : DEFAULT_LLM_SETTINGS.targetLanguages,
  };
}

export async function loadLlmSettings(): Promise<LlmSettings> {
  try {
    const raw = await readFile(getLlmSettingsPath(), "utf8");
    return normalizeLlmSettings(JSON.parse(raw) as Partial<LlmSettings>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_LLM_SETTINGS;
    }

    throw error;
  }
}

export async function saveLlmSettings(settings: Partial<LlmSettings>): Promise<LlmSettings> {
  const merged = normalizeLlmSettings(settings);
  await mkdir(getStorageRoot(), { recursive: true });
  await writeFile(getLlmSettingsPath(), JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function getDefaultLlmSettings(): LlmSettings {
  return DEFAULT_LLM_SETTINGS;
}
