import type { BrowserEventType } from "./enums.js";
import type {
  CookieData,
  IndexedDBDatabase,
  LocalStorageData,
  SessionStorageData,
} from "../services/context/types.js";
import { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import type { CredentialsOptions } from "../modules/sessions/sessions.schema.js";

export type OptimizeBandwidthOptions = {
  blockImages?: boolean;
  blockMedia?: boolean;
  blockStylesheets?: boolean;
  blockHosts?: string[];
  blockUrlPatterns?: string[];
};

export type AntiDetectionPreset = "default" | "windows_kr";

export type AntiDetectionMode = "balanced" | "strict";

export interface AntiDetectionOptions {
  enabled?: boolean;
  preset?: AntiDetectionPreset;
  mode?: AntiDetectionMode;
}

export interface ResolvedAntiDetection {
  enabled: boolean;
  preset: AntiDetectionPreset;
  mode: AntiDetectionMode;
  locale: string;
  languages: string[];
  acceptLanguage: string;
  accept: string;
  timezone: string;
  navigatorPlatform: string;
  userAgentPlatform: string;
  vendor: string;
  userAgent: string;
  device: "desktop" | "mobile";
  dimensions: {
    width: number;
    height: number;
  };
  fingerprintLocales: string[];
  fingerprintOperatingSystems: Array<"windows" | "linux" | "macos" | "android" | "ios">;
  navigationHeaders: {
    accept: string;
    acceptLanguage: string;
    secChUa: string;
    secChUaMobile: string;
    secChUaPlatform: string;
    upgradeInsecureRequests: string;
    secFetchSite: string;
    secFetchMode: string;
    secFetchUser: string;
    secFetchDest: string;
    priority: string;
  };
  userAgentMetadata: {
    brands: Array<{ brand: string; version: string }>;
    fullVersionList: Array<{ brand: string; version: string }>;
    fullVersion: string;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    mobile: boolean;
    bitness: string;
    wow64: boolean;
  };
}

export interface BrowserLauncherOptions {
  options: BrowserServerOptions;
  req?: Request;
  stealth?: boolean;
  sessionContext?: {
    cookies?: CookieData[];
    localStorage?: Record<string, LocalStorageData>;
    sessionStorage?: Record<string, SessionStorageData>;
    indexedDB?: Record<string, IndexedDBDatabase[]>;
  };
  userAgent?: string;
  extensions?: string[];
  logSinkUrl?: string;
  blockAds?: boolean;
  fingerprint?: BrowserFingerprintWithHeaders;
  optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
  customHeaders?: Record<string, string>;
  timezone?: Promise<string>;
  dimensions?: {
    width: number;
    height: number;
  } | null;
  antiDetection?: ResolvedAntiDetection;
  userDataDir?: string;
  userPreferences?: Record<string, any>;
  extra?: Record<string, Record<string, string>>;
  credentials?: CredentialsOptions;
  skipFingerprintInjection?: boolean;
  deviceConfig?: { device: "desktop" | "mobile" };
  dangerouslyLogRequestDetails?: boolean;
}

export interface BrowserServerOptions {
  args?: string[];
  chromiumSandbox?: boolean;
  devtools?: boolean;
  downloadsPath?: string;
  headless?: boolean;
  ignoreDefaultArgs?: boolean | string[];
  proxyUrl?: string;
  timeout?: number;
  tracesDir?: string;
}

export type BrowserEvent = {
  type: BrowserEventType;
  text: string;
  timestamp: Date;
};
