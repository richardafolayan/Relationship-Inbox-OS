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

export class SessionManager {
  private readonly personMutex = createKeyedMutex();
  private readonly globalResetMutex = createKeyedMutex();
  private readonly states = new Map<string, SessionState>();

  constructor(private readonly deps: SessionManagerDependencies) {}

  getProfileDir(personKey = "default"): string {
    return join(this.deps.profileRootDir, sanitizePersonKey(personKey));
  }

  async getManagedPage(input: {
    platform: PlatformName;
    personKey?: string;
    args?: string[];
  }): Promise<Page> {
    const personKey = sanitizePersonKey(input.personKey ?? "default");
    return this.personMutex.runExclusive(`person:${personKey}`, async () => {
      const state = this.getOrCreateState(personKey);
      const context = await this.ensureContextLocked({
        state,
        platform: input.platform,
        args: input.args
      });

      const existing = state.pages.get(input.platform);
      if (existing && !existing.isClosed()) {
        return existing;
      }

      if (existing?.isClosed()) {
        state.pages.delete(input.platform);
      }

      const page = await context.newPage();
      state.pages.set(input.platform, page);
      page.on("close", () => {
        const current = state.pages.get(input.platform);
        if (current === page) {
          state.pages.delete(input.platform);
        }
      });
      return page;
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
    await this.personMutex.runExclusive(`person:${personKey}`, async () => {
      const state = this.states.get(personKey);
      const page = state?.pages.get(input.platform);
      if (!state || !page) {
        return;
      }

      state.pages.delete(input.platform);
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
      pages: new Map<PlatformName, Page>()
    };
    this.states.set(personKey, created);
    return created;
  }

  private async ensureContextLocked(input: {
    state: SessionState;
    platform: PlatformName;
    args?: string[];
  }): Promise<BrowserContext> {
    if (input.state.context && isContextUsable(input.state.context)) {
      return input.state.context;
    }

    input.state.context = null;
    input.state.pages.clear();

    if (input.state.contextPromise) {
      return input.state.contextPromise;
    }

    await mkdir(resolve(input.state.profileDir), { recursive: true });
    input.state.contextPromise = this.launchContext({
      platform: input.platform,
      profileDir: input.state.profileDir,
      args: input.args
    });

    try {
      const context = await input.state.contextPromise;
      input.state.context = context;
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

    const context = state.context;
    state.context = null;
    state.contextPromise = null;
    if (context) {
      await context.close().catch(() => undefined);
    }
  }
}

export function createSessionManager(deps: SessionManagerDependencies): SessionManager {
  return new SessionManager(deps);
}
