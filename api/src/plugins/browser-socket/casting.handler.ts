import { IncomingMessage } from "http";
import puppeteer, { Browser, CDPSession, Frame, Page } from "puppeteer-core";
import { Duplex } from "stream";
import WebSocket, { Server } from "ws";

import { env } from "../../env.js";
import { SessionService } from "../../services/session.service.js";
import {
  CloseTabEvent,
  GetSelectedTextEvent,
  KeyEvent,
  MouseEvent,
  NavigationEvent,
  PageInfo,
} from "../../types/casting.js";
import { getPageFavicon, getPageTitle, navigatePage } from "../../utils/casting.js";

const FIRST_FRAME_TIMEOUT_MS = 4000;
const CAPTURE_INTERVAL_MS = 250;
const RETRYABLE_CAPTURE_BACKOFF_MS = 150;
const POST_NAVIGATION_RECOVERY_WINDOW_MS = 5000;
const MAX_CONSECUTIVE_RETRYABLE_FAILURES = 30;
const MAX_REATTACH_ATTEMPTS = 3;

type CastStreamPhase = "warming" | "live" | "degraded";

export function isRetryableCastCaptureError(message: string): boolean {
  const normalized = message.toLowerCase();

  return [
    "target closed",
    "session closed",
    "execution context was destroyed",
    "cannot find context with specified id",
    "inspected target navigated or closed",
    "main frame",
    "not attached to an active page",
    "frame was detached",
    "captureScreenshot timed out",
    "timed out",
    "tab target session is not defined",
  ].some((candidate) => normalized.includes(candidate));
}

function shouldAttemptTargetReattach(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("target closed") ||
    normalized.includes("session closed") ||
    normalized.includes("execution context was destroyed") ||
    normalized.includes("frame was detached") ||
    normalized.includes("tab target session is not defined")
  );
}

async function getBrowserWsEndpoint() {
  const response = await fetch(`http://127.0.0.1:${env.CDP_REDIRECT_PORT}/json/version`);

  if (!response.ok) {
    throw new Error(`Failed to resolve browser websocket endpoint: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
  const debuggerUrl = payload.webSocketDebuggerUrl;

  if (!debuggerUrl) {
    throw new Error("Browser websocket endpoint is missing from /json/version response.");
  }

  const resolvedUrl = new URL(debuggerUrl);

  if (!resolvedUrl.port) {
    resolvedUrl.port = env.CDP_REDIRECT_PORT;
  }

  if (resolvedUrl.hostname === "0.0.0.0") {
    resolvedUrl.hostname = "127.0.0.1";
  }

  return resolvedUrl.toString();
}

export async function handleCastSession(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: Server,
  sessionService: SessionService,
  params: Record<string, string> | undefined,
): Promise<void> {
  const id = request.url?.split("/sessions/")[1].split("/cast")[0];

  if (!id) {
    console.error("Cast Session ID not found");
    socket.destroy();
    return;
  }

  const session = await sessionService.activeSession;
  if (!session) {
    console.error(`Cast Session ${id} not found`);
    socket.destroy();
    return;
  }

  const queryParams = new URLSearchParams(request.url?.split("?")[1] || "");
  const requestedPageId = params?.pageId || queryParams.get("pageId") || null;
  const requestedPageIndex = params?.pageIndex || queryParams.get("pageIndex") || null;

  const tabDiscoveryMode =
    queryParams.get("tabInfo") === "true" || (!requestedPageId && !requestedPageIndex);

  wss.handleUpgrade(request, socket, head, async (ws) => {
    let browser: Browser | null = null;
    let targetPage: Page | null = null;
    let targetClient: CDPSession | null = null;
    let targetPageId: string | null = null;
    let firstFrameTimeout: NodeJS.Timeout | null = null;
    let captureIntervalTimeout: NodeJS.Timeout | null = null;
    let hasReceivedFirstFrame = false;
    let cachedPageTitle: string | null = null;
    let cachedPageFavicon: string | null = null;
    let navigationMetadataListener: ((frame: Frame) => void | Promise<void>) | null = null;
    let cleanupStarted = false;
    let streamPhase: CastStreamPhase = "warming";
    const openedAt = Date.now();
    let lastNavigationAt = openedAt;
    let consecutiveRetryableFailures = 0;
    let reattachAttempts = 0;

    const activePages = new Map<string, Page>();

    let heartbeatInterval: NodeJS.Timeout | null = null;

    const handleSessionCleanup = () => {
      if (cleanupStarted) {
        return;
      }

      cleanupStarted = true;

      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      if (firstFrameTimeout) {
        clearTimeout(firstFrameTimeout);
        firstFrameTimeout = null;
      }

      if (captureIntervalTimeout) {
        clearTimeout(captureIntervalTimeout);
        captureIntervalTimeout = null;
      }

      if (targetPage) {
        if (navigationMetadataListener) {
          targetPage.off("framenavigated", navigationMetadataListener);
          navigationMetadataListener = null;
        }
      }

      // Clean up screencast
      if (targetClient) {
        try {
          targetClient.detach().catch((err) => {
            // Ignore errors about closed targets
            if (!err.message?.includes("Target closed")) {
              console.error("Error detaching client:", err);
            }
          });

          targetClient = null;
        } catch (err) {
          console.error("Error during screencast cleanup:", err);
        }
      }

      // Disconnect browser
      if (browser) {
        try {
          browser.disconnect().catch((err) => {
            console.error("Error disconnecting browser:", err);
          });
          browser = null;
        } catch (err) {
          console.error("Error during browser disconnect:", err);
        }
      }

      // Force garbage collection if available (Node.js with --expose-gc flag)
      if (global.gc) {
        try {
          global.gc();
        } catch (err) {
          console.error("Error during garbage collection:", err);
        }
      }
    };

    const attachNavigationMetadataListener = (page: Page) => {
      if (targetPage && navigationMetadataListener) {
        targetPage.off("framenavigated", navigationMetadataListener);
      }

      navigationMetadataListener = async (frame: Frame) => {
        if (!targetPage || frame !== targetPage.mainFrame()) {
          return;
        }

        lastNavigationAt = Date.now();

        try {
          cachedPageTitle = await getPageTitle(targetPage);
          cachedPageFavicon = await getPageFavicon(targetPage);
        } catch (error) {
          console.error(`Error refreshing page metadata for ${targetPageId}:`, error);
        }
      };

      page.on("framenavigated", navigationMetadataListener);
    };

    const sendTabList = async () => {
      try {
        if (ws.readyState !== WebSocket.OPEN || !tabDiscoveryMode) return;

        const tabList: PageInfo[] = [];

        for (const [pageId, page] of activePages.entries()) {
          tabList.push({
            id: pageId,
            url: page.url(),
            title: await getPageTitle(page),
            favicon: await getPageFavicon(page),
          });
        }

        ws.send(
          JSON.stringify({
            type: "tabList",
            tabs: tabList,
            firstTabId: tabList.length > 0 ? tabList[0].id : null,
          }),
        );
      } catch (error) {
        console.error("Error sending tab list:", error);
      }
    };

    const findTargetPage = async (
      pages: Page[],
    ): Promise<{ page: Page; pageId: string } | null> => {
      if (tabDiscoveryMode) return null; // No target page in tab discovery mode

      if (requestedPageId) {
        for (const page of pages) {
          try {
            //@ts-expect-error
            const pageId = page.target()._targetId;
            if (pageId === requestedPageId) {
              return { page, pageId };
            }
          } catch (err) {
            console.error("Error accessing page target ID:", err);
          }
        }
      } else if (requestedPageIndex) {
        const index = parseInt(requestedPageIndex, 10);
        if (index >= 0 && index < pages.length) {
          const page = pages[index];
          //@ts-expect-error
          const pageId = page.target()._targetId;
          return { page, pageId };
        }
      }

      return null;
    };

    const scheduleNextCapture = (delayMs = CAPTURE_INTERVAL_MS) => {
      if (captureIntervalTimeout) {
        clearTimeout(captureIntervalTimeout);
      }

      captureIntervalTimeout = setTimeout(() => {
        void captureFrame();
      }, delayMs);
    };

    const reattachTargetSession = async () => {
      if (!browser) {
        return false;
      }

      if (targetClient) {
        try {
          await targetClient.detach().catch(() => undefined);
        } catch {
        }

        targetClient = null;
      }

      const pages = await browser.pages();
      const targetResult = await findTargetPage(pages);

      if (!targetResult) {
        return false;
      }

      targetPage = targetResult.page;
      targetPageId = targetResult.pageId;
      cachedPageTitle = await getPageTitle(targetPage);
      cachedPageFavicon = await getPageFavicon(targetPage);
      attachNavigationMetadataListener(targetPage);
      targetClient = await targetPage.target().createCDPSession();

      return true;
    };

    const closeStreamWithError = (payload: { type: "castTimeout" | "castError" | "targetClosed"; pageId: string | null; error?: string }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }

      handleSessionCleanup();
      ws.close();
    };

    const captureFrame = async () => {
      if (!targetClient || !targetPage || ws.readyState !== WebSocket.OPEN || cleanupStarted) {
        return;
      }

      try {
        const screenshot = (await targetClient.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 75,
          fromSurface: true,
        })) as { data?: string };

        if (!screenshot.data) {
          throw new Error("Screenshot payload was empty.");
        }

        if (streamPhase === "degraded") {
          console.warn(
            `Cast stream recovered for pageId=${targetPageId} after ${consecutiveRetryableFailures} retryable failure(s).`,
          );
        }

        hasReceivedFirstFrame = true;
        if (firstFrameTimeout) {
          clearTimeout(firstFrameTimeout);
          firstFrameTimeout = null;
        }

        streamPhase = "live";
        consecutiveRetryableFailures = 0;
        reattachAttempts = 0;
        ws.send(
          JSON.stringify({
            pageId: targetPageId,
            url: targetPage.url(),
            title: cachedPageTitle,
            favicon: cachedPageFavicon,
            data: screenshot.data,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = isRetryableCastCaptureError(message);
        const inRecoveryWindow = !hasReceivedFirstFrame || Date.now() - lastNavigationAt <= POST_NAVIGATION_RECOVERY_WINDOW_MS;

        if (retryable) {
          consecutiveRetryableFailures += 1;

          if (streamPhase !== "degraded") {
            console.warn(`Cast stream degraded for pageId=${targetPageId}: ${message}`);
          }

          streamPhase = "degraded";

          if (
            shouldAttemptTargetReattach(message) &&
            reattachAttempts < MAX_REATTACH_ATTEMPTS
          ) {
            reattachAttempts += 1;

            try {
              const reattached = await reattachTargetSession();

              if (reattached) {
                consecutiveRetryableFailures = 0;
                scheduleNextCapture(RETRYABLE_CAPTURE_BACKOFF_MS);
                return;
              }
            } catch (reattachError) {
              console.error(`Failed to reattach cast target for pageId=${targetPageId}:`, reattachError);
            }
          }

          if (inRecoveryWindow || consecutiveRetryableFailures < MAX_CONSECUTIVE_RETRYABLE_FAILURES) {
            scheduleNextCapture(RETRYABLE_CAPTURE_BACKOFF_MS);
            return;
          }
        }

        if (!retryable && ws.readyState === WebSocket.OPEN) {
          console.error(`Error capturing screenshot for pageId=${targetPageId}:`, error);
        }

        if (!hasReceivedFirstFrame) {
          closeStreamWithError({
            type: "castTimeout",
            pageId: targetPageId,
            error: retryable ? "Timed out waiting for the first screencast frame." : message,
          });
          return;
        }

        closeStreamWithError({
          type: "castError",
          pageId: targetPageId,
          error: message,
        });
        return;
      }

      scheduleNextCapture(CAPTURE_INTERVAL_MS);
    };

    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: await getBrowserWsEndpoint(),
      });

      if (!browser) {
        console.error("Failed to connect to browser");
        socket.destroy();
        return;
      }

      const pages = await browser.pages();

      if (tabDiscoveryMode) {
        for (const page of pages) {
          //@ts-expect-error
          const pageId = page.target()._targetId;
          activePages.set(pageId, page);
        }

        // Initial tab list
        await sendTabList();

        // Setup page creation/deletion tracking
        browser.on("targetcreated", async (target) => {
          if (target.type() === "page") {
            try {
              const page = await target.asPage();
              //@ts-expect-error
              const pageId = target._targetId;
              activePages.set(pageId, page);
              await sendTabList();
            } catch (err) {
              console.error("Error handling new target:", err);
            }
          }
        });

        browser.on("targetdestroyed", async (target) => {
          if (target.type() === "page") {
            try {
              //@ts-expect-error
              const pageId = target._targetId;
              if (activePages.has(pageId)) {
                activePages.delete(pageId);

                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: "tabClosed",
                      pageId,
                    }),
                  );

                  await sendTabList();
                }
              }
            } catch (err) {
              console.error("Error handling destroyed target:", err);
            }
          }
        });

        // Setup heartbeat to detect dead connections
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);

        ws.on("close", () => {
          handleSessionCleanup();
        });

        ws.on("error", (err) => {
          console.error("Tab discovery WebSocket error:", err);
          handleSessionCleanup();
        });

        return;
      } else {
        const targetResult = await findTargetPage(pages);

        if (!targetResult) {
          console.error(
            `Target page not found for ${
              requestedPageId ? `pageId=${requestedPageId}` : `pageIndex=${requestedPageIndex}`
            }`,
          );
          socket.destroy();
          return;
        }

        targetPage = targetResult.page;
        targetPageId = targetResult.pageId;
        cachedPageTitle = await getPageTitle(targetPage);
        cachedPageFavicon = await getPageFavicon(targetPage);
        attachNavigationMetadataListener(targetPage);

        // Setup screencast for the target page
        targetClient = await targetPage.target().createCDPSession();

        firstFrameTimeout = setTimeout(() => {
          if (hasReceivedFirstFrame || ws.readyState !== WebSocket.OPEN) {
            return;
          }

          console.error(`Timed out waiting for first screencast frame for pageId=${targetPageId}`);
          ws.send(
            JSON.stringify({
              type: "castTimeout",
              pageId: targetPageId,
              error: "Timed out waiting for the first screencast frame.",
            }),
          );
          handleSessionCleanup();
          ws.close();
        }, FIRST_FRAME_TIMEOUT_MS);

        ws.on("message", async (message) => {
          try {
            const data:
              | MouseEvent
              | KeyEvent
              | NavigationEvent
              | CloseTabEvent
              | GetSelectedTextEvent = JSON.parse(message.toString());
            const { type } = data;

            if (!targetClient || !targetPage) {
              console.error("No target page or client available for input handling");
              return;
            }

            switch (type) {
              case "mouseEvent": {
                const { event } = data as MouseEvent;
                await targetClient.send("Input.dispatchMouseEvent", {
                  type: event.type,
                  x: event.x,
                  y: event.y,
                  button: event.button,
                  buttons: event.button === "none" ? 0 : 1,
                  clickCount: event.clickCount || 1,
                  modifiers: event.modifiers || 0,
                  deltaX: event.deltaX,
                  deltaY: event.deltaY,
                });
                break;
              }
              case "keyEvent": {
                const { event } = data as KeyEvent;
                await targetClient.send("Input.dispatchKeyEvent", {
                  type: event.type,
                  text: event.text,
                  unmodifiedText: event.text ? event.text.toLowerCase() : undefined,
                  code: event.code,
                  key: event.key,
                  windowsVirtualKeyCode: event.keyCode,
                  nativeVirtualKeyCode: event.keyCode,
                  modifiers: event.modifiers || 0,
                  autoRepeat: false,
                  isKeypad: false,
                  isSystemKey: false,
                });
                break;
              }
              case "navigation": {
                const { event } = data as NavigationEvent;
                lastNavigationAt = Date.now();
                consecutiveRetryableFailures = 0;
                reattachAttempts = 0;
                await navigatePage(event, targetPage);
                break;
              }
              case "closeTab": {
                const { pageId } = data as CloseTabEvent;
                await targetPage?.close();
                if (activePages.has(pageId)) {
                  activePages.delete(pageId);
                }
                break;
              }
              case "getSelectedText": {
                try {
                  const selectedText = await targetPage.evaluate(() => {
                    const selection = window.getSelection();
                    return selection ? selection.toString() : "";
                  });

                  // Send the selected text back to the client
                  ws.send(
                    JSON.stringify({
                      type: "selectedTextResponse",
                      pageId: (data as GetSelectedTextEvent).pageId,
                      text: selectedText,
                    }),
                  );
                } catch (error) {
                  console.error("Failed to get selected text:", error);
                  ws.send(
                    JSON.stringify({
                      type: "selectedTextResponse",
                      pageId: (data as GetSelectedTextEvent).pageId,
                      text: "",
                      error: error instanceof Error ? error.message : "Unknown error",
                    }),
                  );
                }
                break;
              }

              default:
                console.warn("Unknown event type:", type);
            }
          } catch (err) {
            console.error("Error handling WebSocket message:", err);
          }
        });

        void captureFrame();

        // Cleanup when target is destroyed
        browser.on("targetdestroyed", async (target) => {
          if (target.type() === "page") {
            try {
              //@ts-expect-error
              const pageId = target._targetId;

              if (pageId === targetPageId) {
                if (ws.readyState === WebSocket.OPEN) {
                  closeStreamWithError({
                    type: "targetClosed",
                    pageId: targetPageId,
                  });
                }
              }
            } catch (err) {
              console.error("Error handling destroyed target:", err);
            }
          }
        });

        // Setup heartbeat to detect dead connections
        heartbeatInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.ping();
            } catch (err) {
              console.error("Error sending ping:", err);
              handleSessionCleanup();
            }
          } else {
            handleSessionCleanup();
          }
        }, 30000);

        // Cleanup on WebSocket closure
        ws.on("close", () => {
          handleSessionCleanup();
        });

        // Handle errors
        ws.on("error", (err) => {
          console.error("Cast WebSocket error:", err);
          handleSessionCleanup();
        });
      }
    } catch (err) {
      console.error("Error in cast session:", err);
      handleSessionCleanup();
      socket.destroy();
    }
  });
}
