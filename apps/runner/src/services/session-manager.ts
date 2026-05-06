import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import type { AppSettings, PlatformName } from "@inbox-os/core";
import type { BrowserContext, Page } from "playwright";
import type { BrowserProfileConfig } from "../config.js";
import {
  launchPersistentContextForPlatform,
  type ConnectStepInfo,
  type PersonalProfileFallbackInfo
} from "../platforms/browser-launch.js";
import { createKeyedMutex } from "./keyed-mutex.js";
import type { RunLogger } from "./run-logger.js";

interface SessionManagerDependencies {
  profileRootDir: string;
  browserProfile: BrowserProfileConfig;
  getSettings: () => Promise<AppSettings>;
  launchPersistentContext?: (userDataDir: string, options: {
    headless: boolean;
    viewport: null;
    args?: string[];
    channel?: string;
  }) => Promise<BrowserContext>;
  onConnectStep?: (info: ConnectStepInfo) => Promise<void> | void;
  onPersonalProfileFallback?: (info: PersonalProfileFallbackInfo) => Promise<void> | void;
}

interface SessionState {
  profileDir: string;
  context: BrowserContext | null;
  contextPromise: Promise<BrowserContext> | null;
  pages: Map<PlatformName, Page>;
  pageOwners: Map<Page, PlatformName>;
  activeLeases: Map<PlatformName, number>;
  runLoggers: Map<PlatformName, RunLogger>;
}

function sanitizePersonKey(personKey: string): string {
  const trimmed = personKey.trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9_-]+/g, "-");
  return safe || "default";
}

function isContextUsable(context: BrowserContext): boolean {
  try {
    context.pages();
    return true;
  } catch {
    return false;
  }
}

function isBlankPageUrl(url: string): boolean {
  const trimmed = url.trim().toLowerCase();
  return trimmed === "" || trimmed === "about:blank";
}

function isPageOpen(page: Page): boolean {
  try {
    return !page.isClosed();
  } catch {
    return false;
  }
}

function isRecoverableContextCreatePageError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /target page, context or browser has been closed/i.test(message) ||
    /context closed/i.test(message) ||
    /failed to open a new tab/i.test(message) ||
    /target\.createtarget/i.test(message)
  );
}

export class SessionManager {
  private readonly personMutex = createKeyedMutex();
  private readonly globalResetMutex = createKeyedMutex();
  private readonly states = new Map<string, SessionState>();
  private readonly observedContexts = new WeakSet<BrowserContext>();

  constructor(private readonly deps: SessionManagerDependencies) {}

  getProfileDir(personKey = "default"): string {
    return join(this.deps.profileRootDir, sanitizePersonKey(personKey));
  }

  async getManagedPage(input: {
    platform: PlatformName;
    personKey?: string;
    args?: string[];
    runLogger?: RunLogger;
  }): Promise<Page> {
    const personKey = sanitizePersonKey(input.personKey ?? "default");
    return this.personMutex.runExclusive(`person:${personKey}`, async () => {
      const state = this.getOrCreateState(personKey);
      const runLogger = input.runLogger;
      if (runLogger?.enabled) {
        state.runLoggers.set(input.platform, runLogger);
      } else {
        state.runLoggers.delete(input.platform);
      }

      this.logTrace(runLogger, {
        action: "get_managed_page_start",
        details: {
          personKey,
          platform: input.platform,
          hasExistingPage: state.pages.has(input.platform),
          hasContext: Boolean(state.context)
        }
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const context = await this.ensureContextLocked({
          state,
          platform: input.platform,
          args: input.args,
          runLogger
        });

        const existing = state.pages.get(input.platform);
        if (existing && !existing.isClosed()) {
          this.logTrace(runLogger, {
            action: "reused_existing_page",
            details: {
              platform: input.platform,
              url: existing.url()
            },
            url: existing.url()
          });
          return existing;
        }

        if (existing?.isClosed()) {
          state.pages.delete(input.platform);
          state.pageOwners.delete(existing);
          this.logTrace(runLogger, {
            level: "warn",
            action: "dropped_closed_page",
            details: {
              platform: input.platform
            }
          });
        }

        try {
          const reusableBlank = this.findReusableBlankPageLocked({
            context,
            state,
            platform: input.platform
          });

          const page = reusableBlank ?? (await context.newPage());
          this.registerPageLocked(state, input.platform, page, runLogger);
          this.logTrace(runLogger, {
            action: reusableBlank ? "reused_blank_page" : "created_new_page",
            details: {
              platform: input.platform,
              url: page.url()
            },
            url: page.url(),
            attempt: attempt + 1
          });
          await this.closeUnassignedBlankPagesLocked({
            context,
            state,
            keepPage: page
          });
          return page;
        } catch (error) {
          if (attempt >= 1 || !isRecoverableContextCreatePageError(error)) {
            this.logTrace(runLogger, {
              level: "error",
              action: "get_managed_page_failed",
              details: {
                platform: input.platform,
                attempt: attempt + 1,
                message: error instanceof Error ? error.message : String(error)
              }
            });
            throw error;
          }
          this.logTrace(runLogger, {
            level: "warn",
            action: "new_page_recoverable_error",
            details: {
              platform: input.platform,
              attempt: attempt + 1,
              message: error instanceof Error ? error.message : String(error)
            }
          });
          await this.clearContextStateLocked(state, context);
        }
      }

      this.logTrace(runLogger, {
        level: "error",
        action: "get_managed_page_exhausted_retries",
        details: {
          platform: input.platform
        }
      });
      throw new Error(`Failed to acquire managed page for ${input.platform}`);
    });
  }

  async withPlatformLease<T>(input: {
    platform: PlatformName;
    personKey?: string;
  }, work: () => Promise<T>): Promise<T> {
    const personKey = sanitizePersonKey(input.personKey ?? "default");
    await this.personMutex.runExclusive(`person:${personKey}`, async () => {
      const state = this.getOrCreateState(personKey);
      const current = state.activeLeases.get(input.platform) ?? 0;
      state.activeLeases.set(input.platform, current + 1);
    });

    try {
      return await work();
    } finally {
      await this.personMutex.runExclusive(`person:${personKey}`, async () => {
        const state = this.states.get(personKey);
        if (!state) {
          return;
        }
        const current = state.activeLeases.get(input.platform) ?? 0;
        if (current <= 1) {
          state.activeLeases.delete(input.platform);
        } else {
          state.activeLeases.set(input.platform, current - 1);
        }
      });
    }
  }

  async getActiveLeaseCount(input: { platform?: PlatformName; personKey?: string }): Promise<number> {
    const personKey = sanitizePersonKey(input.personKey ?? "default");
    return this.personMutex.runExclusive(`person:${personKey}`, async () => {
      const state = this.states.get(personKey);
      if (!state) {
        return 0;
      }
      if (input.platform) {
        return state.activeLeases.get(input.platform) ?? 0;
      }
      let total = 0;
      for (const count of state.activeLeases.values()) {
        total += count;
      }
      return total;
    });
  }

  async resetPersonSession(input: {
    personKey?: string;
    reason?: string;
    clearProfileDir?: boolean;
  }): Promise<{ personKey: string; profileDir: string; clearedProfileDir: boolean }> {
    const personKey = sanitizePersonKey(input.personKey ?? "default");
    const clearProfileDir = input.clearProfileDir ?? true;

    return this.globalResetMutex.runExclusive(`global-reset:${personKey}`, async () => {
      await this.waitForLeaseDrain({
        personKey,
        timeoutMs: 12_000
      });
      return this.personMutex.runExclusive(`person:${personKey}`, async () => {
        const state = this.states.get(personKey);
        const profileDir = this.getProfileDir(personKey);

        if (state) {
          await this.closeState(state);
          this.states.delete(personKey);
        }

        if (clearProfileDir) {
          await rm(profileDir, { recursive: true, force: true });
          await mkdir(profileDir, { recursive: true });
        }

        return {
          personKey,
          profileDir,
          clearedProfileDir: clearProfileDir
        };
      });
    });
  }

  async closePlatformPage(input: { platform: PlatformName; personKey?: string }): Promise<void> {
    const personKey = sanitizePersonKey(input.personKey ?? "default");
    await this.waitForLeaseDrain({
      personKey,
      platform: input.platform,
      timeoutMs: 8_000
    });
    await this.personMutex.runExclusive(`person:${personKey}`, async () => {
      const state = this.states.get(personKey);
      const page = state?.pages.get(input.platform);
      if (!state || !page) {
        return;
      }

      state.pages.delete(input.platform);
      state.pageOwners.delete(page);
      if (!page.isClosed()) {
        await page.close().catch(() => undefined);
      }
    });
  }

  private getOrCreateState(personKey: string): SessionState {
    const existing = this.states.get(personKey);
    if (existing) {
      return existing;
    }

    const created: SessionState = {
      profileDir: this.getProfileDir(personKey),
      context: null,
      contextPromise: null,
      pages: new Map<PlatformName, Page>(),
      pageOwners: new Map<Page, PlatformName>(),
      activeLeases: new Map<PlatformName, number>(),
      runLoggers: new Map<PlatformName, RunLogger>()
    };
    this.states.set(personKey, created);
    return created;
  }

  private async ensureContextLocked(input: {
    state: SessionState;
    platform: PlatformName;
    args?: string[];
    runLogger?: RunLogger;
  }): Promise<BrowserContext> {
    if (input.state.context && isContextUsable(input.state.context)) {
      this.logTrace(input.runLogger, {
        action: "reused_context",
        details: {
          platform: input.platform
        }
      });
      return input.state.context;
    }

    this.logTrace(input.runLogger, {
      action: "context_invalid_or_missing",
      details: {
        platform: input.platform
      }
    });
    input.state.context = null;
    input.state.pages.clear();
    input.state.pageOwners.clear();

    if (input.state.contextPromise) {
      this.logTrace(input.runLogger, {
        action: "await_existing_context_promise",
        details: {
          platform: input.platform
        }
      });
      return input.state.contextPromise;
    }

    await mkdir(resolve(input.state.profileDir), { recursive: true });
    this.logTrace(input.runLogger, {
      action: "launch_context_start",
      details: {
        platform: input.platform,
        profileDir: input.state.profileDir
      }
    });
    input.state.contextPromise = this.launchContext({
      platform: input.platform,
      profileDir: input.state.profileDir,
      args: input.args
    });

    try {
      const context = await input.state.contextPromise;
      input.state.context = context;
      this.attachContextCloseListener(input.state, context);
      // Polyfill esbuild/tsx-injected `__name` helper in the page context.
      // tsx 4.x hardcodes `keepNames: true` in its esbuild config, which wraps
      // every function with `__name(fn, "name")`. When such a function is
      // passed to `page.evaluate(...)`, the browser has no `__name` and throws
      // `ReferenceError: __name is not defined`. The polyfill is a no-op
      // identity function that swallows the helper call. Safe in production
      // dist (where `__name` isn't injected) — the script just defines a
      // global the code never uses.
      //
      // The `as ...` casts are because Playwright's BrowserContext type isn't
      // fully captured in the test fakes; we feature-detect the methods so
      // unit tests with minimal mock contexts don't have to implement them.
      const NAME_POLYFILL_SOURCE =
        "if (typeof globalThis.__name === 'undefined') { globalThis.__name = function (fn) { return fn; }; }";
      const ctxAny = context as { addInitScript?: (input: { content: string }) => Promise<void>; pages?: () => Array<{ evaluate?: (script: string) => Promise<unknown> }> };
      if (typeof ctxAny.addInitScript === "function") {
        await ctxAny.addInitScript({ content: NAME_POLYFILL_SOURCE }).catch(() => undefined);
      }
      if (typeof ctxAny.pages === "function") {
        for (const existingPage of ctxAny.pages()) {
          if (typeof existingPage.evaluate === "function") {
            await existingPage.evaluate(NAME_POLYFILL_SOURCE).catch(() => undefined);
          }
        }
      }
      this.logTrace(input.runLogger, {
        action: "launch_context_ok",
        details: {
          platform: input.platform
        }
      });
      return context;
    } finally {
      input.state.contextPromise = null;
    }
  }

  private async launchContext(input: {
    platform: PlatformName;
    profileDir: string;
    args?: string[];
  }): Promise<BrowserContext> {
    const settings = await this.deps.getSettings();
    return launchPersistentContextForPlatform({
      platform: input.platform,
      launchPersistentContext:
        this.deps.launchPersistentContext ??
        ((userDataDir, options) => chromium.launchPersistentContext(userDataDir, options)),
      isolatedProfileDir: input.profileDir,
      headless: settings.headless,
      browserProfile: this.deps.browserProfile,
      args: input.args,
      onConnectStep: this.deps.onConnectStep,
      onPersonalProfileFallback: this.deps.onPersonalProfileFallback
    });
  }

  private async closeState(state: SessionState): Promise<void> {
    for (const page of state.pages.values()) {
      if (!page.isClosed()) {
        await page.close().catch(() => undefined);
      }
    }
    state.pages.clear();
    state.pageOwners.clear();

    const context = state.context;
    state.context = null;
    state.contextPromise = null;
    state.activeLeases.clear();
    this.logTraceForState(state, {
      action: "close_state",
      details: {
        hadContext: Boolean(context)
      }
    });
    state.runLoggers.clear();
    if (context) {
      await context.close().catch(() => undefined);
    }
  }

  private async clearContextStateLocked(state: SessionState, context?: BrowserContext | null): Promise<void> {
    const activeContext = context ?? state.context;
    state.context = null;
    state.contextPromise = null;
    state.pages.clear();
    state.pageOwners.clear();
    this.logTraceForState(state, {
      level: "warn",
      action: "clear_context_state",
      details: {
        hadContext: Boolean(activeContext)
      }
    });
    state.runLoggers.clear();
    if (activeContext) {
      await activeContext.close().catch(() => undefined);
    }
  }

  private attachContextCloseListener(state: SessionState, context: BrowserContext): void {
    if (this.observedContexts.has(context)) {
      return;
    }
    this.observedContexts.add(context);

    const maybeEmitter = context as BrowserContext & {
      on?: (event: "close", listener: () => void) => void;
    };
    if (typeof maybeEmitter.on !== "function") {
      return;
    }

    maybeEmitter.on("close", () => {
      if (state.context !== context) {
        return;
      }
      state.context = null;
      state.contextPromise = null;
      state.pages.clear();
      state.pageOwners.clear();
      this.logTraceForState(state, {
        level: "warn",
        action: "context_closed",
        details: {}
      });
      state.runLoggers.clear();
    });
  }

  private async waitForLeaseDrain(input: {
    personKey: string;
    platform?: PlatformName;
    timeoutMs: number;
  }): Promise<void> {
    const deadline = Date.now() + Math.max(1_000, input.timeoutMs);
    while (Date.now() < deadline) {
      const active = await this.personMutex.runExclusive(`person:${input.personKey}`, async () => {
        const state = this.states.get(input.personKey);
        if (!state) {
          return 0;
        }
        if (input.platform) {
          return state.activeLeases.get(input.platform) ?? 0;
        }
        let total = 0;
        for (const count of state.activeLeases.values()) {
          total += count;
        }
        return total;
      });
      if (active <= 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const scope = input.platform ? `${input.personKey}:${input.platform}` : input.personKey;
    throw new Error(`Timed out waiting for active platform lease(s) to drain for ${scope}`);
  }

  private registerPageLocked(state: SessionState, platform: PlatformName, page: Page, runLogger?: RunLogger): void {
    state.pages.set(platform, page);
    state.pageOwners.set(page, platform);
    if (runLogger?.enabled) {
      state.runLoggers.set(platform, runLogger);
    }
    page.on("close", () => {
      const current = state.pages.get(platform);
      if (current === page) {
        state.pages.delete(platform);
      }
      state.pageOwners.delete(page);
      this.logTrace(state.runLoggers.get(platform), {
        level: "warn",
        action: "page_closed",
        details: {
          platform
        }
      });
    });
  }

  private findReusableBlankPageLocked(input: {
    context: BrowserContext;
    state: SessionState;
    platform: PlatformName;
  }): Page | null {
    const pages = input.context.pages();
    for (const page of pages) {
      if (!isPageOpen(page)) {
        continue;
      }

      const owner = input.state.pageOwners.get(page);
      if (owner && owner !== input.platform) {
        continue;
      }

      const mappedToOtherPlatform = Array.from(input.state.pages.entries()).some(
        ([platformName, mappedPage]) => platformName !== input.platform && mappedPage === page
      );
      if (mappedToOtherPlatform) {
        continue;
      }

      const currentUrl = page.url();
      if (!isBlankPageUrl(currentUrl)) {
        continue;
      }

      return page;
    }

    return null;
  }

  private async closeUnassignedBlankPagesLocked(input: {
    context: BrowserContext;
    state: SessionState;
    keepPage: Page;
  }): Promise<void> {
    const pages = input.context.pages();
    for (const page of pages) {
      if (page === input.keepPage) {
        continue;
      }

      if (!isPageOpen(page)) {
        continue;
      }

      const owner = input.state.pageOwners.get(page);
      if (owner) {
        continue;
      }

      const mapped = Array.from(input.state.pages.values()).some((mappedPage) => mappedPage === page);
      if (mapped) {
        continue;
      }

      if (!isBlankPageUrl(page.url())) {
        continue;
      }

      await page.close().catch(() => undefined);
    }
  }

  private logTrace(
    logger: RunLogger | undefined,
    input: {
      level?: "debug" | "info" | "warn" | "error";
      action: string;
      details: Record<string, unknown>;
      stage?: string | null;
      url?: string;
      attempt?: number;
    }
  ): void {
    if (!logger?.enabled) {
      return;
    }
    logger.logEvent({
      level: input.level ?? "info",
      component: "session-manager",
      stage: input.stage ?? "session_lifecycle",
      action: input.action,
      details: input.details,
      url: input.url,
      attempt: input.attempt
    });
  }

  private logTraceForState(
    state: SessionState,
    input: {
      level?: "debug" | "info" | "warn" | "error";
      action: string;
      details: Record<string, unknown>;
      stage?: string | null;
      url?: string;
      attempt?: number;
    }
  ): void {
    const seen = new Set<RunLogger>();
    for (const logger of state.runLoggers.values()) {
      if (seen.has(logger)) {
        continue;
      }
      seen.add(logger);
      this.logTrace(logger, input);
    }
  }
}

export function createSessionManager(deps: SessionManagerDependencies): SessionManager {
  return new SessionManager(deps);
}
