import Anthropic from "@anthropic-ai/sdk";

import type { AnthropicConfig, LlmCallOptions, LlmCallResult } from "./types";

export async function callAnthropic(
  config: AnthropicConfig,
  options: LlmCallOptions,
): Promise<LlmCallResult> {
  if (!config.apiKey) {
    throw new Error("Anthropic API 키가 설정되어 있지 않습니다. 설정 화면에서 입력해 주세요.");
  }

  const client = new Anthropic({ apiKey: config.apiKey });

  const message = await client.messages.create({
    model: config.model,
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0.3,
    system: options.systemPrompt,
    messages: [{ role: "user", content: options.userPrompt }],
  });

  const text = message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return {
    text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}
