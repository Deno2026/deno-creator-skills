export type DenoSubtitleLanguageCode =
  | "en"
  | "ja"
  | "zh-Hans"
  | "zh-Hant"
  | "ru"
  | "es-419"
  | "es"
  | "id"
  | "pt-BR"
  | "pt-PT"
  | "de"
  | "fr"
  | "fr-CA"
  | "hi"
  | "ar"
  | "vi"
  | "th"
  | "tr"
  | "it"
  | "pl"
  | "nl"
  | "fil"
  | "ms"
  | "sv"
  | "he"
  | "da"
  | "no"
  | "fi"
  | "cs"
  | "ro"
  | "el"
  | "bn"
  | "ur"
  | "ta"
  | "te"
  | "fa"
  | "uk";

export type DenoSubtitleLanguageOption = {
  code: DenoSubtitleLanguageCode;
  label: string;
  nativeLabel: string;
  shortLabel: string;
  uploadFileName: string;
};

export const DENO_SUBTITLE_LANGUAGE_OPTIONS: DenoSubtitleLanguageOption[] = [
  {
    code: "en",
    label: "English",
    nativeLabel: "English",
    shortLabel: "EN",
    uploadFileName: "02_English_en_upload.srt",
  },
  {
    code: "ja",
    label: "Japanese",
    nativeLabel: "日本語",
    shortLabel: "JA",
    uploadFileName: "03_Japanese_ja_upload.srt",
  },
  {
    code: "zh-Hans",
    label: "Chinese Simplified",
    nativeLabel: "中文 简体",
    shortLabel: "ZH-S",
    uploadFileName: "04_Chinese_Simplified_zh-Hans_upload.srt",
  },
  {
    code: "zh-Hant",
    label: "Chinese Traditional",
    nativeLabel: "中文 繁體",
    shortLabel: "ZH-T",
    uploadFileName: "05_Chinese_Traditional_zh-Hant_upload.srt",
  },
  {
    code: "ru",
    label: "Russian",
    nativeLabel: "Русский",
    shortLabel: "RU",
    uploadFileName: "06_Russian_ru_upload.srt",
  },
  {
    code: "es-419",
    label: "Spanish Latin America",
    nativeLabel: "Español Latinoamérica",
    shortLabel: "ES-419",
    uploadFileName: "07_Spanish_Latin_America_es-419_upload.srt",
  },
  {
    code: "es",
    label: "Spanish Spain",
    nativeLabel: "Español España",
    shortLabel: "ES",
    uploadFileName: "08_Spanish_Spain_es_upload.srt",
  },
  {
    code: "id",
    label: "Indonesian",
    nativeLabel: "Bahasa Indonesia",
    shortLabel: "ID",
    uploadFileName: "09_Indonesian_id_upload.srt",
  },
  {
    code: "pt-BR",
    label: "Portuguese Brazil",
    nativeLabel: "Português Brasil",
    shortLabel: "PT-BR",
    uploadFileName: "10_Portuguese_Brazil_pt-BR_upload.srt",
  },
  {
    code: "pt-PT",
    label: "Portuguese Portugal",
    nativeLabel: "Português Portugal",
    shortLabel: "PT-PT",
    uploadFileName: "11_Portuguese_Portugal_pt-PT_upload.srt",
  },
  {
    code: "de",
    label: "German",
    nativeLabel: "Deutsch",
    shortLabel: "DE",
    uploadFileName: "12_German_de_upload.srt",
  },
  {
    code: "fr",
    label: "French",
    nativeLabel: "Français",
    shortLabel: "FR",
    uploadFileName: "13_French_fr_upload.srt",
  },
  {
    code: "fr-CA",
    label: "French Canada",
    nativeLabel: "Français Canada",
    shortLabel: "FR-CA",
    uploadFileName: "14_French_Canada_fr-CA_upload.srt",
  },
  {
    code: "hi",
    label: "Hindi",
    nativeLabel: "हिन्दी",
    shortLabel: "HI",
    uploadFileName: "15_Hindi_hi_upload.srt",
  },
  {
    code: "ar",
    label: "Arabic",
    nativeLabel: "العربية",
    shortLabel: "AR",
    uploadFileName: "16_Arabic_ar_upload.srt",
  },
  {
    code: "vi",
    label: "Vietnamese",
    nativeLabel: "Tiếng Việt",
    shortLabel: "VI",
    uploadFileName: "17_Vietnamese_vi_upload.srt",
  },
  {
    code: "th",
    label: "Thai",
    nativeLabel: "ไทย",
    shortLabel: "TH",
    uploadFileName: "18_Thai_th_upload.srt",
  },
  {
    code: "tr",
    label: "Turkish",
    nativeLabel: "Türkçe",
    shortLabel: "TR",
    uploadFileName: "19_Turkish_tr_upload.srt",
  },
  {
    code: "it",
    label: "Italian",
    nativeLabel: "Italiano",
    shortLabel: "IT",
    uploadFileName: "20_Italian_it_upload.srt",
  },
  {
    code: "pl",
    label: "Polish",
    nativeLabel: "Polski",
    shortLabel: "PL",
    uploadFileName: "21_Polish_pl_upload.srt",
  },
  {
    code: "nl",
    label: "Dutch",
    nativeLabel: "Nederlands",
    shortLabel: "NL",
    uploadFileName: "22_Dutch_nl_upload.srt",
  },
  {
    code: "fil",
    label: "Filipino",
    nativeLabel: "Filipino",
    shortLabel: "FIL",
    uploadFileName: "23_Filipino_fil_upload.srt",
  },
  {
    code: "ms",
    label: "Malay",
    nativeLabel: "Bahasa Melayu",
    shortLabel: "MS",
    uploadFileName: "24_Malay_ms_upload.srt",
  },
  {
    code: "sv",
    label: "Swedish",
    nativeLabel: "Svenska",
    shortLabel: "SV",
    uploadFileName: "25_Swedish_sv_upload.srt",
  },
  {
    code: "he",
    label: "Hebrew",
    nativeLabel: "עברית",
    shortLabel: "HE",
    uploadFileName: "26_Hebrew_he_upload.srt",
  },
  {
    code: "da",
    label: "Danish",
    nativeLabel: "Dansk",
    shortLabel: "DA",
    uploadFileName: "27_Danish_da_upload.srt",
  },
  {
    code: "no",
    label: "Norwegian",
    nativeLabel: "Norsk",
    shortLabel: "NO",
    uploadFileName: "28_Norwegian_no_upload.srt",
  },
  {
    code: "fi",
    label: "Finnish",
    nativeLabel: "Suomi",
    shortLabel: "FI",
    uploadFileName: "29_Finnish_fi_upload.srt",
  },
  {
    code: "cs",
    label: "Czech",
    nativeLabel: "Čeština",
    shortLabel: "CS",
    uploadFileName: "30_Czech_cs_upload.srt",
  },
  {
    code: "ro",
    label: "Romanian",
    nativeLabel: "Română",
    shortLabel: "RO",
    uploadFileName: "31_Romanian_ro_upload.srt",
  },
  {
    code: "el",
    label: "Greek",
    nativeLabel: "Ελληνικά",
    shortLabel: "EL",
    uploadFileName: "32_Greek_el_upload.srt",
  },
  {
    code: "bn",
    label: "Bengali",
    nativeLabel: "বাংলা",
    shortLabel: "BN",
    uploadFileName: "33_Bengali_bn_upload.srt",
  },
  {
    code: "ur",
    label: "Urdu",
    nativeLabel: "اردو",
    shortLabel: "UR",
    uploadFileName: "34_Urdu_ur_upload.srt",
  },
  {
    code: "ta",
    label: "Tamil",
    nativeLabel: "தமிழ்",
    shortLabel: "TA",
    uploadFileName: "35_Tamil_ta_upload.srt",
  },
  {
    code: "te",
    label: "Telugu",
    nativeLabel: "తెలుగు",
    shortLabel: "TE",
    uploadFileName: "36_Telugu_te_upload.srt",
  },
  {
    code: "fa",
    label: "Persian",
    nativeLabel: "فارسی",
    shortLabel: "FA",
    uploadFileName: "37_Persian_fa_upload.srt",
  },
  {
    code: "uk",
    label: "Ukrainian",
    nativeLabel: "Українська",
    shortLabel: "UK",
    uploadFileName: "38_Ukrainian_uk_upload.srt",
  },
];

// 한국어 원본은 별도 필수 트랙이며, 추가 수동 자막의 기본값은 영어 하나다.
export const DENO_DEFAULT_SUBTITLE_LANGUAGES: DenoSubtitleLanguageCode[] =
  ["en"];

const DENO_METADATA_ONLY_LANGUAGE_OPTIONS = [
  { code: "af", label: "Afrikaans", nativeLabel: "Afrikaans", shortLabel: "AF" },
  { code: "am", label: "Amharic", nativeLabel: "አማርኛ", shortLabel: "AM" },
  { code: "as", label: "Assamese", nativeLabel: "অসমীয়া", shortLabel: "AS" },
  { code: "az", label: "Azerbaijani", nativeLabel: "Azərbaycan", shortLabel: "AZ" },
  { code: "be", label: "Belarusian", nativeLabel: "Беларуская", shortLabel: "BE" },
  { code: "bg", label: "Bulgarian", nativeLabel: "Български", shortLabel: "BG" },
  { code: "bs", label: "Bosnian", nativeLabel: "Bosanski", shortLabel: "BS" },
  { code: "ca", label: "Catalan", nativeLabel: "Català", shortLabel: "CA" },
  { code: "en-GB", label: "English United Kingdom", nativeLabel: "English UK", shortLabel: "EN-GB" },
  { code: "en-IN", label: "English India", nativeLabel: "English India", shortLabel: "EN-IN" },
  { code: "es-US", label: "Spanish United States", nativeLabel: "Español Estados Unidos", shortLabel: "ES-US" },
  { code: "et", label: "Estonian", nativeLabel: "Eesti", shortLabel: "ET" },
  { code: "eu", label: "Basque", nativeLabel: "Euskara", shortLabel: "EU" },
  { code: "gl", label: "Galician", nativeLabel: "Galego", shortLabel: "GL" },
  { code: "gu", label: "Gujarati", nativeLabel: "ગુજરાતી", shortLabel: "GU" },
  { code: "hr", label: "Croatian", nativeLabel: "Hrvatski", shortLabel: "HR" },
  { code: "hu", label: "Hungarian", nativeLabel: "Magyar", shortLabel: "HU" },
  { code: "hy", label: "Armenian", nativeLabel: "Հայերեն", shortLabel: "HY" },
  { code: "is", label: "Icelandic", nativeLabel: "Íslenska", shortLabel: "IS" },
  { code: "ka", label: "Georgian", nativeLabel: "ქართული", shortLabel: "KA" },
  { code: "kk", label: "Kazakh", nativeLabel: "Қазақ тілі", shortLabel: "KK" },
  { code: "km", label: "Khmer", nativeLabel: "ខ្មែរ", shortLabel: "KM" },
  { code: "kn", label: "Kannada", nativeLabel: "ಕನ್ನಡ", shortLabel: "KN" },
  { code: "ky", label: "Kyrgyz", nativeLabel: "Кыргызча", shortLabel: "KY" },
  { code: "lo", label: "Lao", nativeLabel: "ລາວ", shortLabel: "LO" },
  { code: "lt", label: "Lithuanian", nativeLabel: "Lietuvių", shortLabel: "LT" },
  { code: "lv", label: "Latvian", nativeLabel: "Latviešu", shortLabel: "LV" },
  { code: "mk", label: "Macedonian", nativeLabel: "Македонски", shortLabel: "MK" },
  { code: "ml", label: "Malayalam", nativeLabel: "മലയാളം", shortLabel: "ML" },
  { code: "mn", label: "Mongolian", nativeLabel: "Монгол", shortLabel: "MN" },
  { code: "mr", label: "Marathi", nativeLabel: "मराठी", shortLabel: "MR" },
  { code: "my", label: "Burmese", nativeLabel: "မြန်မာ", shortLabel: "MY" },
  { code: "ne", label: "Nepali", nativeLabel: "नेपाली", shortLabel: "NE" },
  { code: "or", label: "Odia", nativeLabel: "ଓଡ଼ିଆ", shortLabel: "OR" },
  { code: "pa", label: "Punjabi", nativeLabel: "ਪੰਜਾਬੀ", shortLabel: "PA" },
  { code: "si", label: "Sinhala", nativeLabel: "සිංහල", shortLabel: "SI" },
  { code: "sk", label: "Slovak", nativeLabel: "Slovenčina", shortLabel: "SK" },
  { code: "sl", label: "Slovenian", nativeLabel: "Slovenščina", shortLabel: "SL" },
  { code: "sq", label: "Albanian", nativeLabel: "Shqip", shortLabel: "SQ" },
  { code: "sr-Latn", label: "Serbian Latin", nativeLabel: "Srpski latinica", shortLabel: "SR-L" },
  { code: "sr", label: "Serbian", nativeLabel: "Српски", shortLabel: "SR" },
  { code: "sw", label: "Swahili", nativeLabel: "Kiswahili", shortLabel: "SW" },
  { code: "uz", label: "Uzbek", nativeLabel: "Oʻzbekcha", shortLabel: "UZ" },
  { code: "zh-HK", label: "Chinese Hong Kong", nativeLabel: "中文 香港", shortLabel: "ZH-HK" },
  { code: "zu", label: "Zulu", nativeLabel: "isiZulu", shortLabel: "ZU" },
] as const;

type DenoMetadataOnlyLanguageCode =
  (typeof DENO_METADATA_ONLY_LANGUAGE_OPTIONS)[number]["code"];

export type DenoMetadataLanguageCode =
  | DenoSubtitleLanguageCode
  | DenoMetadataOnlyLanguageCode;

export type DenoMetadataLanguageOption = {
  code: DenoMetadataLanguageCode;
  label: string;
  nativeLabel: string;
  shortLabel: string;
};

export const DENO_METADATA_LANGUAGE_OPTIONS: DenoMetadataLanguageOption[] = [
  ...DENO_SUBTITLE_LANGUAGE_OPTIONS.map(
    ({ code, label, nativeLabel, shortLabel }) => ({
      code,
      label,
      nativeLabel,
      shortLabel,
    }),
  ),
  ...DENO_METADATA_ONLY_LANGUAGE_OPTIONS,
];

// Helper 표시용 현재 snapshot이다. 실제 업로드 완료 기준은 매 작업 시점
// YouTube i18nLanguages.list 재조회 결과이며, 이 배열의 고정 개수가 아니다.
export const DENO_DEFAULT_METADATA_LANGUAGES: DenoMetadataLanguageCode[] =
  DENO_METADATA_LANGUAGE_OPTIONS.map((language) => language.code);
