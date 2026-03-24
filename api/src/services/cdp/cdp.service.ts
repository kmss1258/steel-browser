import { EventEmitter } from "events";
import { FastifyBaseLogger } from "fastify";
import {
  BrowserFingerprintWithHeaders,
  FingerprintGenerator,
  FingerprintGeneratorOptions,
  VideoCard,
} from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import fs from "fs";
import { IncomingMessage } from "http";
import httpProxy from "http-proxy";
import os from "os";
import path from "path";
import puppeteer, {
  Browser,
  BrowserContext,
  CDPSession,
  HTTPRequest,
  Page,
  Protocol,
  Target,
  TargetType,
} from "puppeteer-core";
import { Duplex } from "stream";
import { env } from "../../env.js";
import { loadFingerprintScript } from "../../scripts/index.js";
import { traceable, tracer } from "../../telemetry/tracer.js";
import { BrowserEventType, BrowserLauncherOptions, EmitEvent } from "../../types/index.js";
import {
  tryParseUrl,
  isAdRequest,
  isHeavyMediaRequest,
  isHostBlocked,
  isUrlMatchingPatterns,
  compileUrlPatterns,
  isImageRequest,
} from "../../utils/requests.js";
import {
  filterHeaders,
  getChromeExecutablePath,
  installMouseHelper,
  runPageBootstrapAction,
  safelyReadPageUrl,
} from "../../utils/browser.js";
import {
  deepMerge,
  extractStorageForPage,
  getProfilePath,
  groupSessionStorageByOrigin,
  handleFrameNavigated,
} from "../../utils/context.js";
import { getExtensionPaths } from "../../utils/extensions.js";
import { RetryManager, RetryOptions } from "../../utils/retry.js";
import { ChromeContextService } from "../context/chrome-context.service.js";
import { SessionData } from "../context/types.js";
import { FileService } from "../file.service.js";
import {
  BaseLaunchError,
  BrowserProcessError,
  BrowserProcessState,
  CleanupError,
  CleanupType,
  FingerprintError,
  FingerprintStage,
  LaunchTimeoutError,
  NetworkError,
  NetworkOperation,
  PluginError,
  PluginName,
  PluginOperation,
  ResourceError,
  ResourceType,
  SessionContextError,
  SessionContextType,
  categorizeError,
} from "./errors/launch-errors.js";
import { BasePlugin } from "./plugins/core/base-plugin.js";
import { PluginManager } from "./plugins/core/plugin-manager.js";
import { isSimilarConfig, validateLaunchConfig, validateTimezone } from "./utils/validation.js";
import { TargetInstrumentationManager } from "./instrumentation/target-manager.js";
import {
  createBrowserLogger as createInstrumentationLogger,
  BrowserLogger,
} from "./instrumentation/browser-logger.js";
import { executeBestEffort, executeCritical, executeOptional } from "./utils/error-handlers.js";
import { TimezoneFetcher } from "../timezone-fetcher.service.js";

export class CDPService extends EventEmitter {
  private logger: FastifyBaseLogger;
  private keepAlive: boolean;

  private browserInstance: Browser | null;
  private wsEndpoint: string | null;
  private fingerprintData: BrowserFingerprintWithHeaders | null;
  private sessionContext: SessionData | null;
  private chromeExecPath: string;
  private wsProxyServer: httpProxy;
  private primaryPage: Page | null;
  private launchConfig?: BrowserLauncherOptions;
  private defaultLaunchConfig: BrowserLauncherOptions;
  private currentSessionConfig: BrowserLauncherOptions | null;
  private shuttingDown: boolean;
  private defaultTimezone: string;
  private pluginManager: PluginManager;
  private trackedOrigins: Set<string> = new Set<string>();
  private chromeSessionService: ChromeContextService;
  private retryManager: RetryManager;
  private targetInstrumentationManager: TargetInstrumentationManager;
  private instrumentationLogger: BrowserLogger;

  private compiledUrlPatterns: RegExp[] = [];
  private launchMutators: ((config: BrowserLauncherOptions) => Promise<void> | void)[] = [];
  private shutdownMutators: ((config: BrowserLauncherOptions | null) => Promise<void> | void)[] =
    [];
  private proxyWebSocketHandler:
    | ((req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>)
    | null = null;
  private disconnectHandler: () => Promise<void> = () => this.endSession();

  constructor(
    config: { keepAlive?: boolean },
    logger: FastifyBaseLogger,
    storage?: any,
    enableConsoleLogging?: boolean,
  ) {
    super();
    this.logger = logger.child({ component: "CDPService" });
    const { keepAlive = true } = config;

    this.keepAlive = keepAlive;
    this.browserInstance = null;
    this.wsEndpoint = null;
    this.fingerprintData = null;
    this.sessionContext = null;
    this.chromeExecPath = getChromeExecutablePath();
    this.defaultTimezone = env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.trackedOrigins = new Set<string>();
    this.chromeSessionService = new ChromeContextService(logger);
    this.retryManager = new RetryManager(logger);

    this.wsProxyServer = httpProxy.createProxyServer();

    this.wsProxyServer.on("error", (err) => {
      this.logger.error(`Proxy server error: ${err}`);
    });

    this.primaryPage = null;
    this.currentSessionConfig = null;
    this.shuttingDown = false;

    // Initialize timezone fetcher for cold start
    const timezoneFetcher = new TimezoneFetcher(logger);
    const coldStartTimezone = timezoneFetcher.getTimezone(undefined, this.defaultTimezone);

    this.defaultLaunchConfig = {
      options: {
        headless: env.CHROME_HEADLESS,
        args: [],
        ignoreDefaultArgs: ["--enable-automation"],
      },
      blockAds: true,
      extensions: [],
      userDataDir: env.CHROME_USER_DATA_DIR || path.join(os.tmpdir(), "steel-chrome"),
      timezone: coldStartTimezone,
      userPreferences: {
        plugins: {
          always_open_pdf_externally: true,
          plugins_disabled: ["Chrome PDF Viewer"],
        },
      },
      deviceConfig: { device: "desktop" },
    };

    this.pluginManager = new PluginManager(this, logger);

    this.instrumentationLogger = createInstrumentationLogger({
      baseLogger: this.logger,
      initialContext: {},
      storage: storage || null,
      enableConsoleLogging: enableConsoleLogging ?? true,
    });
    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
    );
    this.instrumentationLogger?.on?.(EmitEvent.Log, (event, context) => {
      this.emit(EmitEvent.Log, event);
    });
    this.logger.info("[CDPService] Target instrumentation enabled");
  }

  public getInstrumentationLogger(): BrowserLogger {
    return this.instrumentationLogger;
  }

  public getLogger(name: string) {
    return this.logger.child({ component: name });
  }

  public setProxyWebSocketHandler(
    handler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>) | null,
  ): void {
    this.proxyWebSocketHandler = handler;
  }

  public setDisconnectHandler(handler: () => Promise<void>): void {
    this.disconnectHandler = handler;
  }

  public getBrowserInstance(): Browser | null {
    return this.browserInstance;
  }

  public getLaunchConfig(): BrowserLauncherOptions | undefined {
    return this.launchConfig;
  }

  public getSessionContext(): SessionData | null {
    return this.sessionContext;
  }

  public registerLaunchHook(fn: (config: BrowserLauncherOptions) => Promise<void> | void) {
    this.launchMutators.push(fn);
  }

  public registerShutdownHook(fn: (config: BrowserLauncherOptions | null) => Promise<void> | void) {
    this.shutdownMutators.push(fn);
  }

  private removeAllHandlers() {
    this.browserInstance?.removeAllListeners();
    this.removeAllListeners();
  }

  public isRunning(): boolean {
    return this.browserInstance?.process() !== null;
  }

  public getTargetId(page: Page) {
    //@ts-ignore
    return page.target()._targetId;
  }

  public async getPrimaryPage(): Promise<Page> {
    if (!this.primaryPage || !this.browserInstance) {
      throw new Error("CDPService has not been launched yet!");
    }
    if (this.primaryPage.isClosed()) {
      this.primaryPage = await this.browserInstance.newPage();
    }
    return this.primaryPage;
  }

  private getDebuggerBase(): { baseUrl: string; protocol: string; wsProtocol: string } {
    const baseUrl = env.CDP_DOMAIN ?? env.DOMAIN ?? `${env.HOST}:${env.CDP_REDIRECT_PORT}`;
    const protocol = env.USE_SSL ? "https" : "http";
    const wsProtocol = env.USE_SSL ? "wss" : "ws";
    return { baseUrl, protocol, wsProtocol };
  }

  public getDebuggerUrl() {
    const { baseUrl, protocol } = this.getDebuggerBase();
    return `${protocol}://${baseUrl}/devtools/devtools_app.html`;
  }

  public getDebuggerWsUrl(pageId?: string) {
    const { baseUrl, wsProtocol } = this.getDebuggerBase();
    return `${wsProtocol}://${baseUrl}/devtools/page/${
      pageId ?? this.getTargetId(this.primaryPage!)
    }`;
  }

  public async refreshPrimaryPage() {
    const newPage = await this.createPage();
    if (this.primaryPage) {
      // Notify plugins before page close
      await this.pluginManager.onBeforePageClose(this.primaryPage);
      await this.primaryPage.close();
    }
    this.primaryPage = newPage;
  }

  public registerPlugin(plugin: BasePlugin) {
    return this.pluginManager.register(plugin);
  }

  public unregisterPlugin(pluginName: string) {
    return this.pluginManager.unregister(pluginName);
  }

  private async handleTargetChange(target: Target) {
    if (target.type() !== "page") return;

    const page = await target.page().catch((e) => {
      this.logger.error(`Error handling target change in CDPService: ${e}`);
      return null;
    });

    if (page) {
      this.pluginManager.onPageNavigate(page);

      //@ts-ignore
      const pageId = page.target()._targetId;

      // Track the origin of the page
      try {
        const url = page.url();
        if (url && url.startsWith("http")) {
          const origin = new URL(url).origin;
          this.trackedOrigins.add(origin);
          this.logger.debug(`[CDPService] Tracking new origin: ${origin}`);
        }
      } catch (err) {
        this.logger.error(`[CDPService] Error tracking origin: ${err}`);
      }

      this.emit(EmitEvent.PageId, { pageId });
    }
  }

  private async waitForTargetPage(
    target: Target,
    context: string,
    attempts = 5,
    delayMs = 100,
  ): Promise<Page | null> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const page = await target.page().catch((error) => {
        this.logger.warn(
          { err: error, attempt, context },
          `[CDPService] Failed to resolve page from target`,
        );
        return null;
      });

      if (page && !page.isClosed()) {
        if (attempt > 1) {
          this.logger.info(
            { attempt, context },
            `[CDPService] Resolved target page after retry`,
          );
        }

        return page;
      }

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    this.logger.warn({ context }, `[CDPService] Target page was not ready in time`);
    return null;
  }

  private async runPageInitializationStep(
    page: Page,
    step: string,
    fn: () => Promise<void>,
  ): Promise<boolean> {
    if (page.isClosed()) {
      this.logger.warn({ step }, `[CDPService] Skipping page init step because page is closed`);
      return false;
    }

    try {
      await fn();
      this.logger.debug({ step }, `[CDPService] Page init step completed`);
      return true;
    } catch (error) {
      this.logger.error({ err: error, step }, `[CDPService] Page init step failed`);
      return false;
    }
  }

  private async applyPageHeaders(page: Page): Promise<void> {
    if (this.launchConfig?.antiDetection?.enabled && this.launchConfig?.antiDetection?.acceptLanguage) {
      await page.setExtraHTTPHeaders({
        "accept-language": this.launchConfig.antiDetection.acceptLanguage,
      });
      return;
    }

    if (!this.launchConfig?.antiDetection?.enabled && this.launchConfig?.customHeaders) {
      await page.setExtraHTTPHeaders({
        ...env.DEFAULT_HEADERS,
        ...this.launchConfig.customHeaders,
      });
      return;
    }

    if (!this.launchConfig?.antiDetection?.enabled && env.DEFAULT_HEADERS) {
      await page.setExtraHTTPHeaders(env.DEFAULT_HEADERS);
    }
  }

  private registerPageResponseGuard(page: Page): void {
    page.on("response", (response) => {
      if (response.url().startsWith("file://")) {
        this.logger.error(`[CDPService] Blocked response from file protocol: ${response.url()}`);
        page.close().catch(() => {});
      }
    });
  }

  private async initializeNewPageTarget(page: Page): Promise<void> {
    await this.runPageInitializationStep(page, "plugin:onPageCreated", async () => {
      await this.pluginManager.onPageCreated(page);
    });

    await this.runPageInitializationStep(page, "mouse-helper", async () => {
      const installed = await installMouseHelper(
        page,
        this.launchConfig?.deviceConfig?.device || "desktop",
      );

      if (!installed) {
        this.logger.warn(`[CDPService] Mouse helper was skipped for the new page target`);
      }
    });

    await this.runPageInitializationStep(page, "headers", async () => {
      await this.applyPageHeaders(page);
    });

    if (!env.SKIP_FINGERPRINT_INJECTION) {
      await this.runPageInitializationStep(page, "fingerprint", async () => {
        await this.injectFingerprintSafely(page, this.fingerprintData);
      });
    } else {
      this.logger.info(
        "[CDPService] Fingerprint injection skipped due to 'SKIP_FINGERPRINT_INJECTION' setting",
      );
    }

    const interceptionEnabled = await this.runPageInitializationStep(
      page,
      "request-interception",
      async () => {
        await page.setRequestInterception(true);
      },
    );

    if (interceptionEnabled) {
      page.on("request", (request) => this.handlePageRequest(request, page));
    }

    this.registerPageResponseGuard(page);
  }

  private getPreferredAcceptLanguage(): string | undefined {
    return (
      this.launchConfig?.customHeaders?.["accept-language"] ||
      this.launchConfig?.antiDetection?.acceptLanguage ||
      env.DEFAULT_HEADERS?.["accept-language"]
    );
  }

  private getPreferredLocale(): string {
    const acceptLanguage = this.getPreferredAcceptLanguage();
    return (
      this.launchConfig?.antiDetection?.locale ||
      acceptLanguage?.split(",")[0]?.split(";")[0]?.trim() ||
      "en-US"
    );
  }

  private buildOrderedHeaders(
    sourceHeaders: Record<string, string>,
    overrides: Record<string, string>,
    preferredOrder: string[],
  ): Record<string, string> {
    const ordered: Record<string, string> = {};
    const source = { ...sourceHeaders, ...overrides };

    for (const key of preferredOrder) {
      const value = source[key];
      if (typeof value === "string" && value.length > 0) {
        ordered[key] = value;
      }
    }

    for (const [key, value] of Object.entries(source)) {
      if (!(key in ordered) && typeof value === "string" && value.length > 0) {
        ordered[key] = value;
      }
    }

    return ordered;
  }

  private async handleNewTarget(target: Target) {
    try {
      await this.targetInstrumentationManager.attach(target, target.type() as TargetType);
    } catch (error) {
      this.logger.error({ err: error }, `[CDPService] Error attaching target instrumentation`);
    }

    if (target.type() === TargetType.PAGE) {
      const page = await this.waitForTargetPage(target, "handleNewTarget");

        if (page) {
        const safePageUrl = safelyReadPageUrl(page) ?? "about:blank";

          this.logger.info(
            { pageId: this.getTargetId(page), url: safePageUrl },
            `[CDPService] Initializing new page target`,
          );

          try {
            if (safePageUrl.startsWith("http")) {
              const origin = new URL(safePageUrl).origin;
              this.trackedOrigins.add(origin);
              this.logger.debug(`[CDPService] Tracking new origin: ${origin}`);
            }
          } catch (err) {
            this.logger.error(`[CDPService] Error tracking origin: ${err}`);
          }

          try {
            await this.initializeNewPageTarget(page);
          } catch (error) {
            this.logger.error({ err: error }, `[CDPService] New page target initialization crashed unexpectedly`);
          }
        }
      } else if (target.type() === TargetType.BACKGROUND_PAGE) {
        this.logger.info(`[CDPService] Background page created: ${target.url()}`);
      }
    }

    private async handlePageRequest(request: HTTPRequest, page: Page) {
      const url = request.url();
      const headers = request.headers();
      const antiDetection = this.launchConfig?.antiDetection;
      const preferredAcceptLanguage = this.getPreferredAcceptLanguage();
      if (!headers["accept-language"] && preferredAcceptLanguage) {
        headers["accept-language"] = preferredAcceptLanguage;
      }

      const parsed = tryParseUrl(url);

      const optimize = this.launchConfig?.optimizeBandwidth;
      const isOptimizeObject = typeof optimize === "object";
      const blockedHosts = isOptimizeObject ? optimize.blockHosts : undefined;

      if (parsed && this.launchConfig?.blockAds && isAdRequest(parsed)) {
        this.logger.info(`[CDPService] Blocked request to ad related resource: ${url}`);
        await request.abort();
        return;
      }

      if (
        (parsed && isHostBlocked(parsed, blockedHosts)) ||
        isUrlMatchingPatterns(url, this.compiledUrlPatterns)
      ) {
        this.logger.info(`[CDPService] Blocked request to blocked host or pattern: ${url}`);
        await request.abort();
        return;
      }

      // Block resources via optimizeBandwidth
      const blockImages = isOptimizeObject ? !!optimize.blockImages : false;
      const blockMedia = isOptimizeObject ? !!optimize.blockMedia : false;
      const blockStylesheets = isOptimizeObject ? !!optimize.blockStylesheets : false;

      if (parsed && (blockImages || blockMedia || blockStylesheets)) {
        const resourceType = request.resourceType();
        if (
          (blockImages && (resourceType === "image" || isImageRequest(parsed))) ||
          (blockMedia && (resourceType === "media" || isHeavyMediaRequest(parsed))) ||
          (blockStylesheets && resourceType === "stylesheet")
        ) {
          this.logger.info(
            `[CDPService] Blocked ${resourceType} resource due to optimizeBandwidth (${
              blockImages ? "blockImages" : ""
            }${blockMedia ? "blockMedia" : ""}${blockStylesheets ? "blockStylesheets" : ""}): ${url}`,
          );
          await request.abort();
          return;
        }
      }

      if (antiDetection?.enabled && request.resourceType() === "document") {
        const navigationHeaders = antiDetection.navigationHeaders;
        const orderedHeaders = this.buildOrderedHeaders(
          headers,
          {
            accept: navigationHeaders.accept,
            "sec-ch-ua": navigationHeaders.secChUa,
            "sec-ch-ua-mobile": navigationHeaders.secChUaMobile,
            "sec-ch-ua-platform": navigationHeaders.secChUaPlatform,
            "upgrade-insecure-requests": navigationHeaders.upgradeInsecureRequests,
          },
          [
            "sec-ch-ua",
            "sec-ch-ua-mobile",
            "sec-ch-ua-platform",
            "upgrade-insecure-requests",
            "user-agent",
            "accept",
            "sec-fetch-site",
            "sec-fetch-mode",
            "sec-fetch-user",
            "sec-fetch-dest",
            "referer",
            "accept-encoding",
            "accept-language",
          ],
        );

        await request.continue({ headers: orderedHeaders });
        return;
      }

      if (url.startsWith("file://")) {
        this.logger.error(`[CDPService] Blocked request to file protocol: ${url}`);
        page.close().catch(() => {});
        await request.abort().catch(() => {});
        return;
      } else {
        await request.continue({ headers });
      }
    }

  public async getBrowserVersionString(): Promise<string> {
    if (!this.browserInstance) {
      return "unknown";
    }

    try {
      return await this.browserInstance.version();
    } catch (error) {
      this.logger.warn({ err: error }, `[CDPService] Failed to read browser version string`);
      return "unknown";
    }
  }

  public async createPage(): Promise<Page> {
    if (!this.browserInstance) {
      throw new Error("Browser instance not initialized");
    }
    return this.browserInstance.newPage();
  }

  private async shutdownHook() {
    for (const mutator of this.shutdownMutators) {
      await mutator(this.currentSessionConfig);
    }
  }

  @traceable
  public async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.logger.info(`[CDPService] Shutting down and cleaning up resources`);

    try {
      if (this.browserInstance) {
        await this.pluginManager.onBrowserClose(this.browserInstance);
      }

      await this.pluginManager.onShutdown();

      this.removeAllHandlers();
      await this.browserInstance?.close();
      await this.browserInstance?.process()?.kill();
      await this.shutdownHook();

      this.logger.info("[CDPService] Cleaning up files during shutdown");
      try {
        await FileService.getInstance().cleanupFiles();
        this.logger.info("[CDPService] Files cleaned successfully");
      } catch (error) {
        this.logger.error(`[CDPService] Error cleaning files during shutdown: ${error}`);
      }

      this.fingerprintData = null;
      this.currentSessionConfig = null;
      this.browserInstance = null;
      this.wsEndpoint = null;
      this.emit("close");
      this.shuttingDown = false;
    } catch (error) {
      this.logger.error(`[CDPService] Error during shutdown: ${error}`);
      // Ensure we complete the shutdown even if plugins throw errors
      await this.browserInstance?.close();
      await this.browserInstance?.process()?.kill();
      await this.shutdownHook();

      try {
        await FileService.getInstance().cleanupFiles();
      } catch (cleanupError) {
        this.logger.error(
          `[CDPService] Error cleaning files during error recovery: ${cleanupError}`,
        );
      }

      this.browserInstance = null;
      this.shuttingDown = false;
    }
  }

  public getBrowserProcess() {
    return this.browserInstance?.process() || null;
  }

  public async createBrowserContext(proxyUrl: string): Promise<BrowserContext> {
    if (!this.browserInstance) {
      throw new Error("Browser instance not initialized");
    }
    return this.browserInstance.createBrowserContext({ proxyServer: proxyUrl });
  }

  @traceable
  public async launch(
    config?: BrowserLauncherOptions,
    retryOptions?: Partial<RetryOptions>,
  ): Promise<Browser> {
    const operation = async () => {
      try {
        return await this.launchInternal(config);
      } catch (error) {
        try {
          await this.pluginManager.onShutdown();
          await this.shutdownHook();
        } catch (e) {
          this.logger.warn(
            `[CDPService] Error during retry cleanup (onShutdown/shutdownHook): ${e}`,
          );
        }
        throw error;
      }
    };

    // Use retry mechanism for the launch process
    const result = await this.retryManager.executeWithRetry(
      operation,
      "Browser Launch",
      retryOptions,
    );

    return result.result;
  }

  @traceable
  private async launchInternal(config?: BrowserLauncherOptions): Promise<Browser> {
    try {
      const launchTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new LaunchTimeoutError(60000)), 60000);
      });

      const launchProcess = (async () => {
        const shouldReuseInstance =
          this.browserInstance &&
          (await isSimilarConfig(this.launchConfig, config || this.defaultLaunchConfig));

        if (shouldReuseInstance) {
          this.logger.info(
            "[CDPService] Reusing existing browser instance with default configuration.",
          );
          this.launchConfig = config || this.defaultLaunchConfig;

          const reuseOptimize = this.launchConfig.optimizeBandwidth;
          const reusePatterns =
            typeof reuseOptimize === "object" ? reuseOptimize.blockUrlPatterns : undefined;
          this.compiledUrlPatterns = reusePatterns?.length ? compileUrlPatterns(reusePatterns) : [];

          await executeCritical(
            async () => this.refreshPrimaryPage(),
            (error) =>
              new BrowserProcessError(
                "Failed to refresh primary page when reusing browser instance",
                BrowserProcessState.PAGE_REFRESH,
                error,
              ),
          );

          // Session context injection - should throw error if it fails
          if (this.launchConfig?.sessionContext) {
            this.logger.debug(
              `[CDPService] Session created with session context, injecting session context`,
            );
            await executeCritical(
              async () =>
                this.injectSessionContext(this.primaryPage!, this.launchConfig!.sessionContext!),
              (error) => {
                const contextError = new SessionContextError(
                  error instanceof Error ? error.message : String(error),
                  SessionContextType.CONTEXT_INJECTION,
                  error,
                );
                this.logger.warn(`[CDPService] ${contextError.message} - throwing error`);
                return contextError;
              },
            );
          }
          await this.pluginManager.onBrowserReady(this.launchConfig);

          return this.browserInstance!;
        } else if (this.browserInstance) {
          this.logger.info(
            "[CDPService] Existing browser instance detected. Closing it before launching a new one.",
          );
          await executeBestEffort(
            this.logger,
            async () => this.shutdown(),
            "Error during shutdown before launch",
          );
        }

        this.launchConfig = config || this.defaultLaunchConfig;

        const optimize = this.launchConfig.optimizeBandwidth;
        const rawPatterns = typeof optimize === "object" ? optimize.blockUrlPatterns : undefined;
        this.compiledUrlPatterns = rawPatterns?.length ? compileUrlPatterns(rawPatterns) : [];

        this.logger.info("[CDPService] Launching new browser instance.");

        // Validate configuration
        await executeCritical(
          async () => validateLaunchConfig(this.launchConfig!),
          (error) => categorizeError(error, "configuration validation"),
        );

        // File cleanup - non-critical, log errors but continue
        this.logger.info("[CDPService] Cleaning up files before browser launch");
        await executeOptional(
          this.logger,
          async () => {
            await FileService.getInstance().cleanupFiles();
            this.logger.info("[CDPService] Files cleaned successfully before launch");
          },
          (error) =>
            new CleanupError(
              error instanceof Error ? error.message : String(error),
              CleanupType.PRE_LAUNCH_FILE_CLEANUP,
              error,
            ),
        );

        const { options, userAgent, userDataDir, fingerprint } = this.launchConfig;
        this.fingerprintData = fingerprint ?? null;

        // Run launch mutators - plugin errors should be caught
        await executeCritical(
          async () => {
            for (const mutator of this.launchMutators) {
              await mutator(this.launchConfig!);
            }
          },
          (error) =>
            new PluginError(
              error instanceof Error ? error.message : String(error),
              PluginName.LAUNCH_MUTATOR,
              PluginOperation.PRE_LAUNCH_HOOK,
              true,
              error,
            ),
        );

        // Fingerprint generation - can fail gracefully
        if (
          !env.SKIP_FINGERPRINT_INJECTION &&
          !this.launchConfig.skipFingerprintInjection &&
          !this.fingerprintData
        ) {
          await executeCritical(
            async () => {
              const antiDetection = this.launchConfig?.antiDetection;
              let fingerprintOptions: Partial<FingerprintGeneratorOptions> = {
                devices: [antiDetection?.device || "desktop"],
                operatingSystems: antiDetection?.fingerprintOperatingSystems || ["linux"],
                browsers: [{ name: "chrome", minVersion: 136 }],
                locales: antiDetection?.fingerprintLocales || ["en-US", "en"],
                screen: {
                  minWidth: this.launchConfig!.dimensions?.width ?? antiDetection?.dimensions.width ?? 1920,
                  minHeight: this.launchConfig!.dimensions?.height ?? antiDetection?.dimensions.height ?? 1080,
                  maxWidth: this.launchConfig!.dimensions?.width ?? antiDetection?.dimensions.width ?? 1920,
                  maxHeight: this.launchConfig!.dimensions?.height ?? antiDetection?.dimensions.height ?? 1080,
                },
              };

              if (this.launchConfig!.deviceConfig?.device === "mobile") {
                fingerprintOptions = {
                  devices: ["mobile"],
                  locales: antiDetection?.fingerprintLocales || ["en-US", "en"],
                };
              }

              const fingerprintGen = new FingerprintGenerator(fingerprintOptions);
              this.fingerprintData = fingerprintGen.getFingerprint();

              if (this.fingerprintData && antiDetection?.enabled) {
                this.fingerprintData.fingerprint.navigator.userAgent =
                  this.launchConfig?.userAgent || antiDetection.userAgent;
                this.fingerprintData.fingerprint.navigator.platform = antiDetection.navigatorPlatform;
                this.fingerprintData.fingerprint.navigator.vendor = antiDetection.vendor;
                this.fingerprintData.headers["accept-language"] = antiDetection.acceptLanguage;
                this.fingerprintData.headers["accept"] = antiDetection.accept;
                this.fingerprintData.headers["sec-ch-ua"] = antiDetection.navigationHeaders.secChUa;
                this.fingerprintData.headers["sec-ch-ua-mobile"] =
                  antiDetection.navigationHeaders.secChUaMobile;
                this.fingerprintData.headers["sec-ch-ua-platform"] =
                  antiDetection.navigationHeaders.secChUaPlatform;
              }
            },
            (error) => {
              this.logger.error({ err: error }, "[CDPService] Error generating fingerprint");
              return new FingerprintError(
                error instanceof Error ? error.message : String(error),
                FingerprintStage.GENERATION,
                error,
              );
            },
          );
        } else if (this.fingerprintData) {
          this.logger.info(
            `[CDPService] Using existing fingerprint with user agent: ${this.fingerprintData.fingerprint.navigator.userAgent}`,
          );
        }

        const isHeadless = !!this.launchConfig?.options?.headless;

        this.currentSessionConfig = {
          ...this.launchConfig,
          dimensions: this.launchConfig.dimensions || this.fingerprintData?.fingerprint.screen,
          userAgent:
            this.launchConfig.userAgent || this.fingerprintData?.fingerprint.navigator.userAgent,
        };

        const extensionPaths = await executeCritical(
          async () => {
            const defaultExtensions = isHeadless ? ["recorder"] : [];
            const customExtensions = this.launchConfig!.extensions
              ? [...this.launchConfig!.extensions]
              : [];

            // Get named extension paths
            const namedExtensionPaths = await getExtensionPaths([
              ...defaultExtensions,
              ...customExtensions,
            ]);

            // Check for session extensions passed from the API
            let sessionExtensionPaths: string[] = [];
            if (this.launchConfig!.extra?.orgExtensions?.paths) {
              sessionExtensionPaths = this.launchConfig!.extra.orgExtensions
                .paths as unknown as string[];
              this.logger.info(
                `[CDPService] Found ${sessionExtensionPaths.length} session extension paths`,
              );
            }

            return [...namedExtensionPaths, ...sessionExtensionPaths];
          },
          (error) =>
            new ResourceError(
              `Failed to resolve extension paths: ${error}`,
              ResourceType.EXTENSIONS,
              false,
              error,
            ),
        );

        let timezone = this.defaultTimezone;
        if (config?.timezone) {
          const validatedTimezone = await executeOptional(
            this.logger,
            async () => {
              if (this.launchConfig?.skipFingerprintInjection) {
                this.logger.info(
                  `Skipping timezone validation as skipFingerprintInjection is enabled`,
                );
                return this.defaultTimezone;
              }
              const tz = await validateTimezone(this.logger, config.timezone!);
              this.logger.info(`Resolved and validated timezone: ${tz}`);
              return tz;
            },
            (error) => {
              this.logger.warn(`Timezone validation failed, using fallback`);
              return categorizeError(error, "timezone validation");
            },
            this.defaultTimezone,
          );
          timezone = validatedTimezone ?? this.defaultTimezone;
        }

        const extensionArgs = extensionPaths.length
          ? [
              `--load-extension=${extensionPaths.join(",")}`,
              `--disable-extensions-except=${extensionPaths.join(",")}`,
            ]
          : [];

        const shouldDisableSandbox =
          env.DISABLE_CHROME_SANDBOX ||
          (typeof process.getuid === "function" && process.getuid() === 0);

        const staticDefaultArgs = [
          "--remote-allow-origins=*",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-features=TranslateUI,BlinkGenPropertyTrees,LinuxNonClientFrame,PermissionPromptSurvey,IsolateOrigins,site-per-process,TouchpadAndWheelScrollLatching,TrackingProtection3pcd,InterestFeedContentSuggestions,PrivacySandboxSettings4,AutofillServerCommunication,OptimizationHints,MediaRouter,DialMediaRouteProvider,CertificateTransparencyComponentUpdater,GlobalMediaControls,AudioServiceOutOfProcess,LazyFrameLoading,AvoidUnnecessaryBeforeUnloadCheckSync",
          "--enable-features=Clipboard",
          "--no-default-browser-check",
          "--disable-sync",
          "--disable-translate",
          "--no-first-run",
          "--disable-search-engine-choice-screen",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--force-webrtc-ip-handling-policy",
          "--disable-touch-editing",
          "--disable-touch-drag-drop",
          "--disable-client-side-phishing-detection",
          "--disable-default-apps",
          "--disable-component-update",
          "--disable-infobars",
          "--disable-breakpad",
          "--disable-background-networking",
          "--disable-session-crashed-bubble",
          "--disable-ipc-flooding-protection",
          "--disable-popup-blocking",
          "--disable-prompt-on-repost",
          "--disable-domain-reliability",
          "--metrics-recording-only",
          "--no-pings",
          "--disable-backing-store-limit",
          "--password-store=basic",
          ...(shouldDisableSandbox
            ? ["--no-sandbox", "--disable-setuid-sandbox", "--no-zygote"]
            : []),
        ];

        const headfulArgs = [
          "--ozone-platform=x11",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
          "--use-gl=swiftshader",
          "--in-process-gpu",
          "--enable-crashpad",
          "--crash-dumps-dir=/tmp/chrome-dumps",
          "--noerrdialogs",
          "--force-device-scale-factor=1",
          "--disable-hang-monitor",
        ];

        const headlessArgs = [
          "--headless=new",
          "--hide-crash-restore-bubble",
          "--disable-blink-features=AutomationControlled",
          // can we just remove this outright?
          `--unsafely-treat-insecure-origin-as-secure=http://localhost:3000,http://${env.HOST}:${env.PORT}`,
        ];

        const dynamicArgs = [
          this.launchConfig.dimensions ? "" : "--start-maximized",
          `--remote-debugging-address=${env.HOST}`,
          "--remote-debugging-port=9222",
          `--window-size=${this.launchConfig.dimensions?.width ?? 1920},${
            this.launchConfig.dimensions?.height ?? 1080
          }`,
          userAgent ? `--user-agent=${userAgent}` : "",
          this.launchConfig.options.proxyUrl
            ? `--proxy-server=${this.launchConfig.options.proxyUrl}`
            : "",
        ];

        const uniq = (xs: string[]) => Array.from(new Set(xs.filter(Boolean)));

        const launchArgs = uniq([
          ...staticDefaultArgs,
          ...(this.launchConfig?.antiDetection?.enabled
            ? [`--lang=${this.getPreferredLocale()}`]
            : []),
          ...(isHeadless ? headlessArgs : headfulArgs),
          ...dynamicArgs,
          ...extensionArgs,
          ...(options.args || []),
          ...(env.CHROME_ARGS || []),
        ]).filter((arg) => !env.FILTER_CHROME_ARGS.includes(arg));

        const finalLaunchOptions = {
          ...options,
          defaultViewport: null,
          args: launchArgs,
          executablePath: this.chromeExecPath,
          ignoreDefaultArgs: ["--enable-automation"],
          timeout: 0,
          env: {
            HOME: os.userInfo().homedir,
            TZ: timezone,
            ...(isHeadless ? {} : { DISPLAY: env.DISPLAY }),
          },
          userDataDir,
          dumpio: env.DEBUG_CHROME_PROCESS, // Enable Chrome process stdout and stderr
        };

        this.logger.info(`[CDPService] Launch Options:`);
        this.logger.info(JSON.stringify(finalLaunchOptions, null, 2));

        if (userDataDir && this.launchConfig.userPreferences) {
          this.logger.info(`[CDPService] Setting up user preferences in ${userDataDir}`);
          await executeBestEffort(
            this.logger,
            async () => this.setupUserPreferences(userDataDir, this.launchConfig!.userPreferences!),
            "Failed to set up user preferences",
          );
        }

        // Browser process launch - most critical step
        this.browserInstance = await executeCritical(
          async () =>
            (await tracer.startActiveSpan("CDPService.launchBrowser", async () => {
              return await puppeteer.launch(finalLaunchOptions);
            })) as unknown as Browser,
          (error) =>
            new BrowserProcessError(
              error instanceof Error ? error.message : String(error),
              BrowserProcessState.LAUNCH_FAILED,
              error,
            ),
        );

        // Plugin notifications - catch individual plugin errors
        await executeOptional(
          this.logger,
          async () => this.pluginManager.onBrowserLaunch(this.browserInstance!),
          (error) =>
            new PluginError(
              error instanceof Error ? error.message : String(error),
              PluginName.PLUGIN_MANAGER,
              PluginOperation.BROWSER_LAUNCH_NOTIFICATION,
              true,
              error,
            ),
        );

        this.browserInstance.on("error", (err) => {
          this.logger.error(`[CDPService] Browser error: ${err}`);
          const error = err as Error;
          this.instrumentationLogger.record({
            type: BrowserEventType.BrowserError,
            error: { message: error?.message, stack: error?.stack },
            timestamp: new Date().toISOString(),
          });
        });

        this.primaryPage = await executeCritical(
          async () => (await this.browserInstance!.pages())[0],
          (error) =>
            new BrowserProcessError(
              "Failed to get primary page from browser instance",
              BrowserProcessState.PAGE_ACCESS,
              error,
            ),
        );

        // Session context injection - should throw error if it fails
        if (this.launchConfig?.sessionContext) {
          this.logger.debug(
            `[CDPService] Session created with session context, injecting session context`,
          );
          await executeCritical(
            async () =>
              this.injectSessionContext(this.primaryPage!, this.launchConfig!.sessionContext!),
            (error) => {
              const contextError = new SessionContextError(
                error instanceof Error ? error.message : String(error),
                SessionContextType.CONTEXT_INJECTION,
                error,
              );
              this.logger.warn(`[CDPService] ${contextError.message} - throwing error`);
              return contextError;
            },
          );
        }

        // Configure browser download behavior
        await executeBestEffort(
          this.logger,
          async () => {
            const downloadPath = FileService.getInstance().getBaseFilesPath();
            const cdpSession = await this.browserInstance!.target().createCDPSession();
            await cdpSession.send("Browser.setDownloadBehavior", {
              behavior: "allow",
              downloadPath: downloadPath,
              eventsEnabled: true,
            });
            await cdpSession.detach();
            this.logger.debug(
              `[CDPService] Download behavior configured with path: ${downloadPath}`,
            );
          },
          "Failed to configure download behavior",
        );

        this.browserInstance.on("targetcreated", this.handleNewTarget.bind(this));
        this.browserInstance.on("targetchanged", this.handleTargetChange.bind(this));
        this.browserInstance.on("targetdestroyed", (target) => {
          const targetId = (target as any)._targetId;
          this.targetInstrumentationManager.detach(targetId);
        });
        this.browserInstance.on("disconnected", this.onDisconnect.bind(this));

        this.wsEndpoint = await executeCritical(
          async () => this.browserInstance!.wsEndpoint(),
          (error) =>
            new NetworkError(
              "Failed to get WebSocket endpoint from browser",
              NetworkOperation.WEBSOCKET_SETUP,
              error,
            ),
        );

        // Final setup steps
        await executeOptional(
          this.logger,
          async () => {
            await this.handleNewTarget(this.primaryPage!.target());
            await this.handleTargetChange(this.primaryPage!.target());
          },
          (error) =>
            new BrowserProcessError(
              error instanceof Error ? error.message : String(error),
              BrowserProcessState.TARGET_SETUP,
              error,
            ),
        );

        try {
          const existingTargets = await this.browserInstance.targets();
          for (const target of existingTargets) {
            if ((target as any)._targetId !== (this.primaryPage.target() as any)._targetId) {
              await this.targetInstrumentationManager.attach(target, target.type() as TargetType);
            }
          }
          this.logger.info(
            `[CDPService] Attached instrumentation to ${existingTargets.length} existing targets`,
          );
        } catch (error) {
          this.logger.error({ err: error }, `[CDPService] Error attaching to existing targets`);
        }

        await this.pluginManager.onBrowserReady(this.launchConfig);

        return this.browserInstance;
      })();

      return (await Promise.race([launchProcess, launchTimeout])) as Browser;
    } catch (error: unknown) {
      const categorizedError =
        error instanceof BaseLaunchError ? error : categorizeError(error, "browser launch");

      this.logger.error(
        {
          error: {
            errorType: categorizedError.type,
            isRetryable: categorizedError.isRetryable,
            context: categorizedError.context,
          },
        },
        `[CDPService] LAUNCH ERROR (${categorizedError.type}): ${categorizedError.message}`,
      );

      throw categorizedError;
    }
  }

  @traceable
  public async proxyWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.proxyWebSocketHandler) {
      this.logger.info("[CDPService] Using custom WebSocket proxy handler");
      await this.proxyWebSocketHandler(req, socket, head);
      return;
    }

    if (!this.wsEndpoint) {
      throw new Error(`WebSocket endpoint not available. Ensure the browser is launched first.`);
    }

    const cleanupListeners = () => {
      this.browserInstance?.off("close", cleanupListeners);
      if (this.browserInstance?.process()) {
        this.browserInstance.process()?.off("close", cleanupListeners);
      }
      this.browserInstance?.off("disconnected", cleanupListeners);
      socket.off("close", cleanupListeners);
      socket.off("error", cleanupListeners);
      this.logger.info("[CDPService] WebSocket connection listeners cleaned up");
    };

    this.browserInstance?.once("close", cleanupListeners);
    if (this.browserInstance?.process()) {
      this.browserInstance.process()?.once("close", cleanupListeners);
    }
    this.browserInstance?.once("disconnected", cleanupListeners);
    socket.once("close", cleanupListeners);
    socket.once("error", cleanupListeners);

    // Increase max listeners
    if (this.browserInstance?.process()) {
      this.browserInstance.process()!.setMaxListeners(60);
    }

    this.wsProxyServer.ws(
      req,
      socket,
      head,
      {
        target: this.wsEndpoint,
      },
      (error) => {
        if (error) {
          this.logger.error(`WebSocket proxy error: ${error}`);
          cleanupListeners(); // Clean up on error too
        }
      },
    );

    socket.on("error", (error) => {
      this.logger.error(`Socket error: ${error}`);
      // Try to end the socket properly on error
      try {
        socket.end();
      } catch (e) {
        this.logger.error(`Error ending socket: ${e}`);
      }
    });
  }

  public getUserAgent() {
    return (
      this.currentSessionConfig?.userAgent || this.fingerprintData?.fingerprint.navigator.userAgent
    );
  }

  public getDimensions() {
    return this.currentSessionConfig?.dimensions || { width: 1920, height: 1080 };
  }

  public getFingerprintData(): BrowserFingerprintWithHeaders | null {
    return this.fingerprintData;
  }

  public async getCookies(): Promise<Protocol.Network.Cookie[]> {
    if (!this.primaryPage) {
      throw new Error("Primary page not initialized");
    }
    const client = await this.primaryPage.createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    await client.detach();
    return cookies;
  }

  public async getBrowserState(): Promise<SessionData> {
    if (!this.browserInstance || !this.primaryPage) {
      throw new Error("Browser or primary page not initialized");
    }

    const userDataDir = this.launchConfig?.userDataDir;

    if (!userDataDir) {
      this.logger.warn("No userDataDir specified, returning empty session data");
      return {};
    }

    try {
      this.logger.info(`[CDPService] Dumping session data from userDataDir: ${userDataDir}`);

      // Run session data extraction and CDP storage extraction in parallel
      const [cookieData, sessionData, storageData] = await Promise.all([
        this.getCookies(),
        this.chromeSessionService.getSessionData(userDataDir),
        this.getExistingPageSessionData(),
      ]);

      // Merge storage data with session data
      const result = {
        cookies: cookieData,
        localStorage: {
          ...(sessionData.localStorage || {}),
          ...(storageData.localStorage || {}),
        },
        sessionStorage: {
          ...(sessionData.sessionStorage || {}),
          ...(storageData.sessionStorage || {}),
        },
        indexedDB: {
          ...(sessionData.indexedDB || {}),
          ...(storageData.indexedDB || {}),
        },
      };

      this.logger.info("[CDPService] Session data dumped successfully");
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[CDPService] Error dumping session data: ${errorMessage}`);
      return {};
    }
  }

  /**
   * Extract all storage data (localStorage, sessionStorage, IndexedDB) for all open pages
   */
  private async getExistingPageSessionData(): Promise<SessionData> {
    if (!this.browserInstance || !this.primaryPage) {
      return {};
    }

    const result: SessionData = {
      localStorage: {},
      sessionStorage: {},
      indexedDB: {},
    };

    try {
      const pages = await this.browserInstance.pages();

      const validPages = pages.filter((page) => {
        try {
          const url = page.url();
          return url && url.startsWith("http");
        } catch (e) {
          return false;
        }
      });

      this.logger.info(
        `[CDPService] Processing ${validPages.length} valid pages out of ${pages.length} total for storage extraction`,
      );

      const results = await Promise.all(
        validPages.map((page) => extractStorageForPage(page, this.logger)),
      );

      // Merge all results
      for (const item of results) {
        for (const domain in item.localStorage) {
          result.localStorage![domain] = {
            ...(result.localStorage![domain] || {}),
            ...item.localStorage![domain],
          };
        }

        for (const domain in item.sessionStorage) {
          result.sessionStorage![domain] = {
            ...(result.sessionStorage![domain] || {}),
            ...item.sessionStorage![domain],
          };
        }

        for (const domain in item.indexedDB) {
          result.indexedDB![domain] = [
            ...(result.indexedDB![domain] || []),
            ...item.indexedDB![domain],
          ];
        }
      }

      return result;
    } catch (error) {
      this.logger.error(`[CDPService] Error extracting storage with CDP: ${error}`);
      return result;
    }
  }

  public async getAllPages() {
    return this.browserInstance?.pages() || [];
  }

  @traceable
  public async startNewSession(sessionConfig: BrowserLauncherOptions): Promise<Browser> {
    this.currentSessionConfig = sessionConfig;
    this.trackedOrigins.clear(); // Clear tracked origins when starting a new session

    // Recreate target instrumentation manager with session-specific options
    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
      { dangerouslyLogRequestDetails: sessionConfig.dangerouslyLogRequestDetails },
    );

    return this.launch(sessionConfig);
  }

  @traceable
  public async endSession(): Promise<void> {
    this.logger.info("Ending current session and resetting to default configuration.");
    const sessionConfig = this.currentSessionConfig!;

    this.sessionContext = await this.getBrowserState().catch(() => null);

    await this.shutdown();
    await this.pluginManager.onSessionEnd(sessionConfig);
    this.currentSessionConfig = null;
    this.sessionContext = null;
    this.trackedOrigins.clear();

    this.instrumentationLogger.resetContext();

    // Reset target instrumentation manager to clear session-specific options
    // (e.g. dangerouslyLogRequestDetails) so they don't leak into the idle browser
    this.targetInstrumentationManager = new TargetInstrumentationManager(
      this.instrumentationLogger,
      this.logger,
    );

    await this.launch(this.defaultLaunchConfig);
  }

  private async onDisconnect(): Promise<void> {
    this.logger.info("Browser disconnected. Handling cleanup.");

    if (this.shuttingDown) {
      return;
    }

    await this.disconnectHandler();
  }

  @traceable
  private async injectSessionContext(
    page: Page,
    context?: BrowserLauncherOptions["sessionContext"],
  ) {
    if (!context) return;

    const storageByOrigin = groupSessionStorageByOrigin(context);

    for (const origin of storageByOrigin.keys()) {
      this.trackedOrigins.add(origin);
    }

    const client = await page.createCDPSession();
    try {
      if (context.cookies?.length) {
        await client.send("Network.setCookies", {
          cookies: context.cookies.map((cookie) => ({
            ...cookie,
            partitionKey: cookie.partitionKey as unknown as Protocol.Network.Cookie["partitionKey"],
          })),
        });
        this.logger.info(`[CDPService] Set ${context.cookies.length} cookies`);
      }
    } catch (error) {
      this.logger.error(`[CDPService] Error setting cookies: ${error}`);
    } finally {
      await client.detach().catch(() => {});
    }

    this.logger.info(
      `[CDPService] Registered frame navigation handler for ${storageByOrigin.size} origins`,
    );
    page.on("framenavigated", (frame) => handleFrameNavigated(frame, storageByOrigin, this.logger));

    page.browser().on("targetcreated", async (target) => {
      if (target.type() === "page") {
        try {
          const newPage = await target.page();
          if (newPage) {
            newPage.on("framenavigated", (frame) =>
              handleFrameNavigated(frame, storageByOrigin, this.logger),
            );
          }
        } catch (err) {
          this.logger.error(`[CDPService] Error adding framenavigated handler to new page: ${err}`);
        }
      }
    });

    this.logger.debug("[CDPService] Session context injection setup complete");
  }

  @traceable
  private async injectFingerprintSafely(
    page: Page,
    fingerprintData: BrowserFingerprintWithHeaders | null,
  ) {
    if (!fingerprintData) return;

    try {
      const { fingerprint, headers } = fingerprintData;
      // TypeScript fix - access userAgent through navigator property
      const userAgent = fingerprint.navigator.userAgent;
      const userAgentMetadata = fingerprint.navigator.userAgentData;
      const antiDetection = this.launchConfig?.antiDetection;
      const acceptLanguage =
        antiDetection?.acceptLanguage || this.getPreferredAcceptLanguage() || headers["accept-language"] ||
        "en-US,en;q=0.9";
      const locale = this.getPreferredLocale();
      const { screen } = fingerprint;

      await page.setUserAgent(userAgent);

      const session = await page.createCDPSession();

      try {
        await session.send("Page.setDeviceMetricsOverride", {
          screenHeight: screen.height,
          screenWidth: screen.width,
          width: screen.width,
          height: screen.height,
          viewport: {
            width: screen.availWidth,
            height: screen.availHeight,
            scale: 1,
            x: 0,
            y: 0,
          },
          mobile: /phone|android|mobile/i.test(userAgent),
          screenOrientation:
            screen.height > screen.width
              ? { angle: 0, type: "portraitPrimary" }
              : { angle: 90, type: "landscapePrimary" },
          deviceScaleFactor: screen.devicePixelRatio,
        });

        if (!antiDetection?.enabled) {
          const injectedHeaders = filterHeaders(headers);
          injectedHeaders["accept-language"] = acceptLanguage;

          await page.setExtraHTTPHeaders(injectedHeaders);
        }

        await session.send("Emulation.setUserAgentOverride", {
          userAgent: userAgent,
          platform:
            antiDetection?.navigatorPlatform || fingerprint.navigator.platform || "Linux x86_64",
          userAgentMetadata: {
            brands:
              (antiDetection?.userAgentMetadata.brands ||
                (userAgentMetadata.brands as unknown as Protocol.Emulation.UserAgentMetadata["brands"])) as Protocol.Emulation.UserAgentMetadata["brands"],
            fullVersionList:
              (antiDetection?.userAgentMetadata.fullVersionList ||
                (userAgentMetadata.fullVersionList as unknown as Protocol.Emulation.UserAgentMetadata["fullVersionList"])) as Protocol.Emulation.UserAgentMetadata["fullVersionList"],
            fullVersion:
              antiDetection?.userAgentMetadata.fullVersion || userAgentMetadata.uaFullVersion,
            platform:
              antiDetection?.userAgentMetadata.platform ||
              antiDetection?.navigatorPlatform ||
              fingerprint.navigator.platform ||
              "Linux x86_64",
            platformVersion:
              antiDetection?.userAgentMetadata.platformVersion || userAgentMetadata.platformVersion || "",
            architecture:
              antiDetection?.userAgentMetadata.architecture || userAgentMetadata.architecture || "x86",
            model: antiDetection?.userAgentMetadata.model || userAgentMetadata.model || "",
            mobile:
              antiDetection?.userAgentMetadata.mobile ??
              (userAgentMetadata.mobile as unknown as boolean),
            bitness:
              antiDetection?.userAgentMetadata.bitness || userAgentMetadata.bitness || "64",
            wow64: antiDetection?.userAgentMetadata.wow64 ?? false,
          },
        });

        await session.send("Emulation.setLocaleOverride", {
          locale,
        });
      } finally {
        // Always detach the session when done
        await session.detach().catch(() => {});
      }

      await this.injectAutomationHardening(page, fingerprintData);

      const fingerprintScriptInstalled = await runPageBootstrapAction(page, async () =>
        page.evaluateOnNewDocument(
          loadFingerprintScript({
            fixedPlatform:
              antiDetection?.navigatorPlatform || fingerprint.navigator.platform || "Linux x86_64",
            fixedVendor: (fingerprint.videoCard as VideoCard | null)?.vendor,
            fixedRenderer: (fingerprint.videoCard as VideoCard | null)?.renderer,
            fixedDeviceMemory: fingerprint.navigator.deviceMemory || 8,
            fixedHardwareConcurrency: fingerprint.navigator.hardwareConcurrency || 8,
            fixedArchitecture:
              antiDetection?.userAgentMetadata.architecture || userAgentMetadata.architecture || "x86",
            fixedBitness:
              antiDetection?.userAgentMetadata.bitness || userAgentMetadata.bitness || "64",
            fixedModel: antiDetection?.userAgentMetadata.model || userAgentMetadata.model || "",
            fixedPlatformVersion:
              antiDetection?.userAgentMetadata.platformVersion || userAgentMetadata.platformVersion || "10.0.0",
            fixedUaFullVersion:
              antiDetection?.userAgentMetadata.fullVersion || userAgentMetadata.uaFullVersion || "145.0.0.0",
            fixedBrands:
              antiDetection?.userAgentMetadata.brands ||
              userAgentMetadata.brands ||
              ([] as unknown as Array<{
                brand: string;
                version: string;
              }>),
          }),
        ),
      );

      if (!fingerprintScriptInstalled) {
        throw new Error("Fingerprint bootstrap script could not be installed before the page became ready.");
      }
    } catch (error) {
      this.logger.error({ error }, `[Fingerprint] Error injecting fingerprint safely`);
      const fingerprintInjector = new FingerprintInjector();
      // @ts-ignore - Ignore type mismatch between puppeteer versions
      await fingerprintInjector.attachFingerprintToPuppeteer(page, fingerprintData);
    }
  }

  @traceable
  private async injectAutomationHardening(
    page: Page,
    fingerprintData: BrowserFingerprintWithHeaders | null,
  ) {
    const fingerprint = fingerprintData?.fingerprint;
    const acceptLanguage = this.getPreferredAcceptLanguage();
    const antiDetection = this.launchConfig?.antiDetection;
    const languages = antiDetection?.languages?.length
      ? antiDetection.languages
      : acceptLanguage
          ?.split(",")
          .map((entry) => entry.split(";")[0]?.trim())
          .filter(Boolean) || ["en-US", "en"];
    const navigatorData = fingerprint?.navigator;
    const pluginNames = [
      "PDF Viewer",
      "Chrome PDF Viewer",
      "Chromium PDF Viewer",
      "Microsoft Edge PDF Viewer",
      "WebKit built-in PDF",
    ];

    const hardeningInstalled = await runPageBootstrapAction(page, async () =>
      page.evaluateOnNewDocument(
        ({ languages, platform, vendor, hardwareConcurrency, deviceMemory, pluginNames, brands, fullVersion }) => {
        const defineValue = (target: object, key: string, value: unknown) => {
          try {
            Object.defineProperty(target, key, {
              configurable: true,
              get: () => value,
            });
          } catch (_error) {}
        };

        const patchIntlResolvedOptions = (
          IntlConstructor:
            | typeof Intl.DateTimeFormat
            | typeof Intl.NumberFormat
            | typeof Intl.Collator
            | typeof Intl.PluralRules
            | typeof Intl.RelativeTimeFormat
            | typeof Intl.ListFormat
            | typeof Intl.DisplayNames
            | undefined,
        ) => {
          if (!IntlConstructor?.prototype?.resolvedOptions) {
            return;
          }

          const originalResolvedOptions = IntlConstructor.prototype.resolvedOptions;
          IntlConstructor.prototype.resolvedOptions = function (...args: unknown[]) {
            const options = originalResolvedOptions.apply(this, args as []);
            return {
              ...options,
              locale: languages[0] || "en-US",
            };
          };
        };

        const makeNamedArray = <T extends Record<string, unknown>>(items: T[], nameKey: keyof T) => {
          const list = items.slice() as T[] & {
            item: (index: number) => T | null;
            namedItem: (name: string) => T | null;
          };
          list.item = (index) => list[index] || null;
          list.namedItem = (name) => list.find((item) => item?.[nameKey] === name) || null;
          return list;
        };

        const mimeTypes = makeNamedArray(
          pluginNames.map((name) => ({
            type: "application/pdf",
            suffixes: "pdf",
            description: "Portable Document Format",
            enabledPlugin: null as unknown,
            name,
          })),
          "type",
        );
        const plugins = makeNamedArray(
          pluginNames.map((name) => ({
            name,
            filename: "internal-pdf-viewer",
            description: "Portable Document Format",
            length: 1,
            0: mimeTypes[0],
          })),
          "name",
        );

        mimeTypes.forEach((mimeType) => {
          mimeType.enabledPlugin = plugins[0];
        });

        defineValue(Navigator.prototype, "webdriver", undefined);
        defineValue(Navigator.prototype, "languages", languages);
        defineValue(Navigator.prototype, "language", languages[0] || "en-US");
        defineValue(Navigator.prototype, "platform", platform || "Win32");
        defineValue(Navigator.prototype, "vendor", vendor || "Google Inc.");
        defineValue(Navigator.prototype, "hardwareConcurrency", hardwareConcurrency || 8);
        defineValue(Navigator.prototype, "deviceMemory", deviceMemory || 8);
        defineValue(Navigator.prototype, "plugins", plugins);
        defineValue(Navigator.prototype, "mimeTypes", mimeTypes);
        defineValue(Navigator.prototype, "pdfViewerEnabled", true);
        const userAgentData = {
          brands,
          mobile: false,
          platform: platform === "Win32" ? "Windows" : platform,
          getHighEntropyValues: async () => ({
            brands,
            fullVersionList: brands.map((brand) => ({
              brand: brand.brand,
              version: brand.version + ".0",
            })),
            fullVersion: fullVersion || (brands[1]?.version ? `${brands[1].version}.0.0` : "145.0.0.0"),
            platform: platform === "Win32" ? "Windows" : platform,
            platformVersion: "10.0.0",
            architecture: "x86",
            model: "",
            mobile: false,
            bitness: "64",
            wow64: false,
          }),
          toJSON: () => ({
            brands,
            mobile: false,
            platform: platform === "Win32" ? "Windows" : platform,
          }),
        };
        defineValue(Navigator.prototype, "userAgentData", userAgentData);
        patchIntlResolvedOptions(Intl.DateTimeFormat);
        patchIntlResolvedOptions(Intl.NumberFormat);
        patchIntlResolvedOptions(Intl.Collator);
        patchIntlResolvedOptions(Intl.PluralRules);
        patchIntlResolvedOptions(Intl.RelativeTimeFormat);
        patchIntlResolvedOptions(Intl.ListFormat);
        patchIntlResolvedOptions(Intl.DisplayNames);

        const chromeValue = (window as Window & { chrome?: unknown }).chrome || {
          runtime: {},
          app: {
            isInstalled: false,
            InstallState: {
              DISABLED: "disabled",
              INSTALLED: "installed",
              NOT_INSTALLED: "not_installed",
            },
            RunningState: {
              CANNOT_RUN: "cannot_run",
              READY_TO_RUN: "ready_to_run",
              RUNNING: "running",
            },
          },
        };
        defineValue(window as Window & { chrome?: unknown }, "chrome", chromeValue);

        if (navigator.permissions?.query) {
          const originalQuery = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = async (parameters: PermissionDescriptor) => {
            if (parameters?.name === "notifications") {
              return { state: Notification.permission } as PermissionStatus;
            }
            return originalQuery(parameters);
          };
        }
        },
        {
          languages,
          platform: antiDetection?.navigatorPlatform || navigatorData?.platform || "Win32",
          vendor: antiDetection?.vendor || navigatorData?.vendor || "Google Inc.",
          hardwareConcurrency: navigatorData?.hardwareConcurrency || 8,
          deviceMemory: navigatorData?.deviceMemory || 8,
          pluginNames,
          brands:
            antiDetection?.userAgentMetadata.brands ||
            (fingerprint?.navigator.userAgentData?.brands as unknown as Array<{ brand: string; version: string }>),
          fullVersion:
            antiDetection?.userAgentMetadata.fullVersion ||
            fingerprint?.navigator.userAgentData?.uaFullVersion ||
            "145.0.0.0",
        },
      ),
    );

    if (!hardeningInstalled) {
      this.logger.warn(`[AutomationHardening] Skipped because the page main frame was not ready in time`);
    }
  }

  @traceable
  private async setupUserPreferences(userDataDir: string, userPreferences: Record<string, any>) {
    try {
      const preferencesPath = getProfilePath(userDataDir, "Preferences");
      const defaultProfileDir = path.dirname(preferencesPath);

      await fs.promises.mkdir(defaultProfileDir, { recursive: true });

      let existingPreferences = {};

      try {
        const existingContent = await fs.promises.readFile(preferencesPath, "utf8");
        existingPreferences = JSON.parse(existingContent);
      } catch (error) {
        this.logger.debug(`[CDPService] No existing preferences found, creating new: ${error}`);
      }

      const mergedPreferences = deepMerge(existingPreferences, userPreferences);

      await fs.promises.writeFile(preferencesPath, JSON.stringify(mergedPreferences, null, 2));

      this.logger.info(`[CDPService] User preferences written to ${preferencesPath}`);
    } catch (error) {
      this.logger.error(`[CDPService] Error setting up user preferences: ${error}`);
      throw error;
    }
  }
}
