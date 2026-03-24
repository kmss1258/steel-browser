import { type Target, type CDPSession, TargetType } from "puppeteer-core";
import type { FastifyBaseLogger } from "fastify";

import { attachPageEvents, AttachPageEventsOptions } from "./page-events.js";
import { attachCDPEvents } from "./cdp-events.js";
import { attachExtensionEvents } from "./extension-events.js";
import { attachWorkerEvents } from "./worker-events.js";
import { BrowserLogger } from "./browser-logger.js";

const INTERNAL_EXTENSIONS = new Set<string>([
  // TODO: need secret manager, recorder, and capacha IDs
]);

export class TargetInstrumentationManager {
  private attachedSessions = new Set<string>();
  private attachingSessions = new Map<string, Promise<void>>();
  private cdpSessions = new Map<string, CDPSession>();

  private pageEventsOptions: AttachPageEventsOptions;

  constructor(
    private logger: BrowserLogger,
    private appLogger: FastifyBaseLogger,
    pageEventsOptions?: AttachPageEventsOptions,
  ) {
    this.pageEventsOptions = pageEventsOptions ?? {};
  }

  private async waitForTargetPage(
    target: Target,
    sessionId: string,
    attempts = 5,
    delayMs = 100,
  ) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const page = await target.page().catch((err) => {
        this.appLogger.warn(
          { err, sessionId, attempt },
          `[TargetManager] Failed to resolve page from target`,
        );
        return null;
      });

      if (page && !page.isClosed()) {
        if (attempt > 1) {
          this.appLogger.info(
            { sessionId, attempt },
            `[TargetManager] Resolved target page after retry`,
          );
        }

        return page;
      }

      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    this.appLogger.warn({ sessionId }, `[TargetManager] Target page was not ready in time`);
    return null;
  }

  async attach(target: Target, type: TargetType) {
    const url = target.url?.() ?? "";
    const isExtensionTarget = url.startsWith("chrome-extension://");
    const sessionId = (target as any)._targetId;

    if (this.attachedSessions.has(sessionId)) {
      return;
    }

    const inFlightAttach = this.attachingSessions.get(sessionId);
    if (inFlightAttach) {
      await inFlightAttach;
      return;
    }

    const attachPromise = this.attachInternal(target, type, sessionId, isExtensionTarget)
      .catch((err) => {
        this.appLogger.warn({ err, sessionId, type }, `[TargetManager] Target attach failed`);
      })
      .finally(() => {
        if (this.attachingSessions.get(sessionId) === attachPromise) {
          this.attachingSessions.delete(sessionId);
        }
      });

    this.attachingSessions.set(sessionId, attachPromise);
    await attachPromise;
  }

  private async attachInternal(
    target: Target,
    type: TargetType,
    sessionId: string,
    isExtensionTarget: boolean,
  ) {
    let session: CDPSession | null = null;

    try {
      session = await target.createCDPSession();
      this.cdpSessions.set(sessionId, session);
      await this.enableDomainsForTarget(session, type, isExtensionTarget);

      switch (type) {
        case TargetType.PAGE:
        case TargetType.BACKGROUND_PAGE: {
          const page = await this.waitForTargetPage(target, sessionId);
          if (page) {
            await attachPageEvents(page, session, this.logger, type, this.pageEventsOptions);
          }

          attachCDPEvents(session, this.logger);

          if (isExtensionTarget) {
            await attachExtensionEvents(target, this.logger, INTERNAL_EXTENSIONS, this.appLogger);
          }
          break;
        }

        case TargetType.SERVICE_WORKER:
        case TargetType.SHARED_WORKER:
        case TargetType.WEBVIEW: {
          attachCDPEvents(session, this.logger);

          if (isExtensionTarget) {
            await attachExtensionEvents(target, this.logger, INTERNAL_EXTENSIONS, this.appLogger);
          } else {
            attachWorkerEvents(target, session, this.logger, type);
          }
          break;
        }

        case TargetType.BROWSER:
        case TargetType.OTHER:
        default: {
          attachCDPEvents(session, this.logger);

          if (isExtensionTarget) {
            await attachExtensionEvents(target, this.logger, INTERNAL_EXTENSIONS, this.appLogger);
          }
          break;
        }
      }

      this.attachedSessions.add(sessionId);
    } catch (err) {
      this.cdpSessions.delete(sessionId);
      if (session) {
        session.detach().catch(() => {});
      }
      throw err;
    }
  }

  detach(targetId: string) {
    this.attachedSessions.delete(targetId);
    const session = this.cdpSessions.get(targetId);
    if (session) {
      this.cdpSessions.delete(targetId);
      session.detach().catch(() => {
        // Session may already be closed if the target was destroyed
      });
    }
  }

  private async enableDomainsForTarget(
    session: CDPSession,
    type: TargetType,
    isExtension: boolean,
  ): Promise<void> {
    const enabledDomains = new Set<string>();

    const enable = async (domain: string) => {
      if (enabledDomains.has(domain)) return;
      try {
        await session.send(`${domain}.enable` as any);
        enabledDomains.add(domain);
      } catch (err) {
        this.appLogger.error({ err }, `[TargetManager] Failed to enable ${domain} for ${type}:`);
      }
    };

    switch (type) {
      case TargetType.PAGE:
      case TargetType.BACKGROUND_PAGE:
        await enable("Runtime");
        await enable("Log");
        await enable("Network");
        break;

      case TargetType.SERVICE_WORKER:
      case TargetType.SHARED_WORKER:
        await enable("Runtime");
        await enable("Log");
        if (isExtension) {
          await enable("Network");
        }
        break;

      case TargetType.WEBVIEW:
      case TargetType.OTHER:
        if (isExtension) {
          await enable("Runtime");
          await enable("Log");
          await enable("Network");
        }
        break;

      default:
        break;
    }
  }
}
