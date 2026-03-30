import {
  AntiDetectionOptions,
  AntiDetectionPreset,
  ResolvedAntiDetection,
} from "../types/browser.js";

type AntiDetectionPresetConfig = Omit<ResolvedAntiDetection, "enabled" | "preset">;

export const DEFAULT_ANTI_DETECTION: Required<AntiDetectionOptions> = {
  enabled: true,
  preset: "default",
  mode: "strict",
};

const DEFAULT_WINDOWS_KR_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const DEFAULT_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";

const DEFAULT_ACCEPT_LANGUAGE = "ko,en-US;q=0.9,en;q=0.8,ja;q=0.7";

const DEFAULT_SEC_CH_UA =
  '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"';

const DEFAULT_SEC_CH_UA_FULL_VERSION_LIST = [
  { brand: "Not:A-Brand", version: "99.0.0.0" },
  { brand: "Google Chrome", version: "145.0.0.0" },
  { brand: "Chromium", version: "145.0.0.0" },
];

const DEFAULT_SEC_CH_UA_MOBILE = "?0";
const DEFAULT_SEC_CH_UA_PLATFORM = '"Windows"';

const PRESET_CONFIGS: Record<AntiDetectionPreset, AntiDetectionPresetConfig> = {
  default: {
    mode: "strict",
    locale: "ko",
    languages: ["ko", "en-US", "en", "ja"],
    acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
    accept: DEFAULT_ACCEPT,
    timezone: "Asia/Seoul",
    navigatorPlatform: "Win32",
    userAgentPlatform: "Windows",
    vendor: "Google Inc.",
    userAgent: DEFAULT_WINDOWS_KR_USER_AGENT,
    device: "desktop",
    dimensions: { width: 1356, height: 763 },
    fingerprintLocales: ["ko", "en-US", "en", "ja"],
    fingerprintOperatingSystems: ["windows"],
    navigationHeaders: {
      accept: DEFAULT_ACCEPT,
      acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
      secChUa: DEFAULT_SEC_CH_UA,
      secChUaMobile: DEFAULT_SEC_CH_UA_MOBILE,
      secChUaPlatform: DEFAULT_SEC_CH_UA_PLATFORM,
      upgradeInsecureRequests: "1",
      secFetchSite: "same-origin",
      secFetchMode: "navigate",
      secFetchUser: "?1",
      secFetchDest: "document",
      priority: "u=0, i",
    },
    userAgentMetadata: {
      brands: DEFAULT_SEC_CH_UA_FULL_VERSION_LIST.map(({ brand, version }) => ({
        brand,
        version: version.split(".")[0] || version,
      })),
      fullVersionList: DEFAULT_SEC_CH_UA_FULL_VERSION_LIST,
      fullVersion: "145.0.0.0",
      platform: "Windows",
      platformVersion: "10.0.0",
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  },
  windows_kr: {
    mode: "strict",
    locale: "ko",
    languages: ["ko", "en-US", "en", "ja"],
    acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
    accept: DEFAULT_ACCEPT,
    timezone: "Asia/Seoul",
    navigatorPlatform: "Win32",
    userAgentPlatform: "Windows",
    vendor: "Google Inc.",
    userAgent: DEFAULT_WINDOWS_KR_USER_AGENT,
    device: "desktop",
    dimensions: { width: 1356, height: 763 },
    fingerprintLocales: ["ko", "en-US", "en", "ja"],
    fingerprintOperatingSystems: ["windows"],
    navigationHeaders: {
      accept: DEFAULT_ACCEPT,
      acceptLanguage: DEFAULT_ACCEPT_LANGUAGE,
      secChUa: DEFAULT_SEC_CH_UA,
      secChUaMobile: DEFAULT_SEC_CH_UA_MOBILE,
      secChUaPlatform: DEFAULT_SEC_CH_UA_PLATFORM,
      upgradeInsecureRequests: "1",
      secFetchSite: "same-origin",
      secFetchMode: "navigate",
      secFetchUser: "?1",
      secFetchDest: "document",
      priority: "u=0, i",
    },
    userAgentMetadata: {
      brands: DEFAULT_SEC_CH_UA_FULL_VERSION_LIST.map(({ brand, version }) => ({
        brand,
        version: version.split(".")[0] || version,
      })),
      fullVersionList: DEFAULT_SEC_CH_UA_FULL_VERSION_LIST,
      fullVersion: "145.0.0.0",
      platform: "Windows",
      platformVersion: "10.0.0",
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false,
    },
  },
};

export function resolveAntiDetection(options?: {
  antiDetection?: AntiDetectionOptions;
  userAgent?: string;
  timezone?: string;
  dimensions?: { width: number; height: number };
  deviceConfig?: { device: "desktop" | "mobile" };
}): ResolvedAntiDetection {
  const input = options?.antiDetection;

  if (input?.enabled === false) {
    return {
      ...PRESET_CONFIGS.default,
      enabled: false,
      preset: input.preset || DEFAULT_ANTI_DETECTION.preset,
      mode: input.mode || DEFAULT_ANTI_DETECTION.mode,
      userAgent: options?.userAgent || PRESET_CONFIGS.default.userAgent,
      timezone: options?.timezone || PRESET_CONFIGS.default.timezone,
      dimensions: options?.dimensions || PRESET_CONFIGS.default.dimensions,
      device: options?.deviceConfig?.device || PRESET_CONFIGS.default.device,
    };
  }

  const preset = input?.preset || DEFAULT_ANTI_DETECTION.preset;
  const presetConfig = PRESET_CONFIGS[preset];

  return {
    ...presetConfig,
    enabled: true,
    preset,
    mode: input?.mode || presetConfig.mode,
    userAgent: options?.userAgent || presetConfig.userAgent,
    timezone: options?.timezone || presetConfig.timezone,
    dimensions: options?.dimensions || presetConfig.dimensions,
    device: options?.deviceConfig?.device || presetConfig.device,
  };
}
