export type OpenAiCompatPreset = {
  id: string;
  label: string;
  baseUrl: string;
  note: string;
  keyLabel: string;
  modelPlaceholder: string;
};

export const OPENAI_COMPAT_PRESETS: OpenAiCompatPreset[] = [
  {
    id: "openai",
    label: "OpenAI 공식 API",
    baseUrl: "https://api.openai.com/v1",
    note: "OpenAI API 키와 모델명을 직접 입력",
    keyLabel: "API 키 필요",
    modelPlaceholder: "OpenAI 모델명",
  },
  {
    id: "gemini",
    label: "Google Gemini API",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    note: "Gemini의 OpenAI 호환 엔드포인트",
    keyLabel: "Gemini API 키 필요",
    modelPlaceholder: "Gemini 모델명",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    note: "여러 회사 모델을 한 키로 라우팅",
    keyLabel: "OpenRouter 키 필요",
    modelPlaceholder: "예: provider/model 형식",
  },
  {
    id: "lm-studio",
    label: "LM Studio 로컬",
    baseUrl: "http://localhost:1234/v1",
    note: "LM Studio Server 탭에서 모델 로드 후 사용",
    keyLabel: "로컬은 보통 빈 칸 OK",
    modelPlaceholder: "LM Studio에 로드된 모델 ID",
  },
  {
    id: "ollama-openai",
    label: "Ollama 호환 모드",
    baseUrl: "http://localhost:11434/v1",
    note: "가능하면 전용 Ollama provider가 더 안정적",
    keyLabel: "로컬은 보통 빈 칸 OK",
    modelPlaceholder: "예: gemma4:31b-it-q4_K_M",
  },
  {
    id: "vllm-local",
    label: "vLLM / llama.cpp 로컬",
    baseUrl: "http://localhost:8000/v1",
    note: "서버 포트가 다르면 주소만 수정",
    keyLabel: "서버 설정에 따름",
    modelPlaceholder: "서버에 올라간 모델 ID",
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    note: "Groq OpenAI 호환 API",
    keyLabel: "Groq 키 필요",
    modelPlaceholder: "Groq 모델명",
  },
  {
    id: "mistral",
    label: "Mistral AI",
    baseUrl: "https://api.mistral.ai/v1",
    note: "Mistral API 키와 모델명 입력",
    keyLabel: "Mistral 키 필요",
    modelPlaceholder: "Mistral 모델명",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    note: "DeepSeek API 키와 모델명 입력",
    keyLabel: "DeepSeek 키 필요",
    modelPlaceholder: "DeepSeek 모델명",
  },
  {
    id: "xai",
    label: "xAI",
    baseUrl: "https://api.x.ai/v1",
    note: "xAI API 키와 모델명 입력",
    keyLabel: "xAI 키 필요",
    modelPlaceholder: "xAI 모델명",
  },
];

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function findOpenAiCompatPreset(baseUrl: string) {
  const normalized = normalizeBaseUrl(baseUrl);
  return OPENAI_COMPAT_PRESETS.find(
    (preset) => normalizeBaseUrl(preset.baseUrl) === normalized,
  );
}
