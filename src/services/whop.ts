import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import { logger } from "../utils/logger.js";
import { humanPause, stepPause } from "../utils/delay.js";
import type { BotProfile } from "./profile.js";

const WHOP_LOGIN_URL = "https://whop.com/login";
const WHOP_SETTINGS_URL = "https://whop.com/@me/settings/general/";

interface WhopAutomatorConfig {
  headless: boolean;
}

async function humanType(locator: Locator, text: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.click({ force: true });
  await locator.page().waitForTimeout(200 + Math.random() * 300);
  await locator.focus();
  await locator.pressSequentially(text, { delay: 60 + Math.random() * 80 });
}

async function clickSubmit(page: Page): Promise<void> {
  const btn = page.locator(
    'button[type="submit"], button:has-text("Continue"), button:has-text("Sign up"), button:has-text("Log in"), button:has-text("Next"), button:has-text("Submit")',
  ).first();
  await btn.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
  }
}

export class WhopAutomator {
  private browser: Browser | null = null;
  private config: WhopAutomatorConfig;

  constructor(config: WhopAutomatorConfig) {
    this.config = config;
  }

  async launch(): Promise<Browser> {
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });
    logger.info(`Browser launched (headless=${this.config.headless})`);
    return this.browser;
  }

  async newContext(): Promise<BrowserContext> {
    if (!this.browser) throw new Error("Browser not launched");
    const context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "America/New_York",
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });

    return context;
  }

  /**
   * Navigate to Whop login, enter email, submit.
   * Whop will then send a sign-in code to the email.
   */
  async submitEmail(context: BrowserContext, email: string): Promise<Page> {
    const page = await context.newPage();
    logger.info(`Navigating to ${WHOP_LOGIN_URL}`);
    await page.goto(WHOP_LOGIN_URL, { waitUntil: "networkidle" });
    await stepPause();

    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="mail" i]').first();
    await emailInput.waitFor({ state: "visible", timeout: 15000 });
    await humanType(emailInput, email);
    await humanPause();

    await clickSubmit(page);
    logger.info("Submitted email — Whop will send a sign-in code");
    await stepPause();

    return page;
  }

  /**
   * Enter the 6-digit verification code on the current page.
   */
  async enterVerificationCode(page: Page, code: string): Promise<void> {
    logger.info(`Entering verification code: ${code}`);

    const singleInput = page.locator(
      'input[name="code"], input[name="otp"], input[placeholder*="code" i], input[autocomplete="one-time-code"], input[inputmode="numeric"]',
    ).first();
    const hasSingle = await singleInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasSingle) {
      await humanType(singleInput, code);
      await humanPause();
      await clickSubmit(page);
    } else {
      const digitInputs = page.locator('input[maxlength="1"], input[data-index]');
      const count = await digitInputs.count();

      if (count >= 6) {
        for (let i = 0; i < 6; i++) {
          const input = digitInputs.nth(i);
          await input.click({ force: true });
          await input.focus();
          await input.pressSequentially(code[i], { delay: 80 + Math.random() * 60 });
          await page.waitForTimeout(100 + Math.random() * 150);
        }
        await humanPause();
        await clickSubmit(page).catch(() => {});
      } else {
        await page.keyboard.type(code, { delay: 100 });
        await clickSubmit(page).catch(() => {});
      }
    }

    logger.info("Verification code submitted");
    await stepPause();
    await page.waitForTimeout(3000);

    await this.dismissPopups(page);
  }

  /**
   * Dismiss any modals/popups that appear after login
   * (e.g. "Claim your free $25 of AI tokens", promotional offers, etc.)
   */
  private async dismissPopups(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.waitForTimeout(1500);

      // Look for common dismiss/confirm/close buttons inside modals
      const dismissSelectors = [
        'button:has-text("Claim")',
        'button:has-text("Confirm")',
        'button:has-text("Got it")',
        'button:has-text("OK")',
        'button:has-text("Accept")',
        'button:has-text("Continue")',
        'button:has-text("Skip")',
        'button:has-text("Close")',
        'button:has-text("No thanks")',
        'button:has-text("Dismiss")',
        'button[aria-label="Close"]',
        'button[aria-label="Dismiss"]',
        '[role="dialog"] button',
        '[class*="modal"] button',
        '[class*="popup"] button',
        '[class*="overlay"] button',
      ];

      let dismissed = false;
      for (const selector of dismissSelectors) {
        const btn = page.locator(selector).first();
        if (await btn.isVisible().catch(() => false)) {
          const text = await btn.textContent().catch(() => "");
          await btn.click();
          logger.info(`Dismissed popup (clicked "${text?.trim()}")`);
          dismissed = true;
          await page.waitForTimeout(1000);
          break;
        }
      }

      if (!dismissed) break;
    }
  }

  /**
   * Navigate to profile settings and update name, username, and profile picture.
   */
  async updateProfile(
    page: Page,
    profile: BotProfile,
    picturePath: string | null,
  ): Promise<void> {
    logger.info(`Navigating to profile settings: ${WHOP_SETTINGS_URL}`);
    await page.goto(WHOP_SETTINGS_URL, { waitUntil: "networkidle", timeout: 30000 });
    await stepPause();
    await this.dismissPopups(page);

    // --- Profile picture (70% of bots get one; triggers crop modal when present) ---
    if (picturePath) {
      const fileInput = page.locator('input[type="file"]').first();
      if (await fileInput.count() > 0) {
        try {
          await fileInput.setInputFiles(picturePath);
        logger.info("Profile picture uploaded — waiting for crop modal");
        await stepPause();
        await this.saveCropModal(page);
      } catch {
        const avatarArea = page.locator(
          '[class*="avatar"], [class*="profile"], [class*="upload"], [class*="photo"], img[alt*="avatar" i], img[alt*="profile" i]',
        ).first();
        if (await avatarArea.isVisible().catch(() => false)) {
          const [chooser] = await Promise.all([
            page.waitForEvent("filechooser", { timeout: 5000 }).catch(() => null),
            avatarArea.click(),
          ]);
          if (chooser) {
            await chooser.setFiles(picturePath);
            logger.info("Profile picture uploaded via file chooser — waiting for crop modal");
            await stepPause();
            await this.saveCropModal(page);
          }
        }
      }
    }
    }

    // --- Name / display name ---
    // Use fill() which properly fires React's onChange/onInput events (unlike clear + pressSequentially)
    const nameInput = page.locator(
      'input[name="name"], input[name="displayName"], input[name="display_name"], input[placeholder*="name" i]:not([name="username"]):not([placeholder*="user" i])',
    ).first();
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.click();
      await page.waitForTimeout(200);
      await nameInput.fill(profile.displayName);
      logger.info(`Set name: ${profile.displayName}`);
      await humanPause();
    }

    // --- Username ---
    const usernameInput = page.locator(
      'input[name="username"], input[placeholder*="username" i]',
    ).first();
    if (await usernameInput.isVisible().catch(() => false)) {
      await usernameInput.click();
      await page.waitForTimeout(200);
      await usernameInput.fill(profile.username);
      logger.info(`Set username: @${profile.username}`);
      await humanPause();
    }

    // Trigger React change detection: blur the active input, then dispatch input events via JS
    await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      active?.blur();
      document.querySelectorAll<HTMLInputElement>('input[name="name"], input[name="username"]').forEach((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    });
    await page.waitForTimeout(1000);

    await this.clickSaveChanges(page);
    logger.info("Profile update complete");
  }

  /**
   * Click the "Save changes" button. Waits for it to become enabled (the form
   * disables it until it detects changes), then clicks it via multiple strategies.
   */
  private async clickSaveChanges(page: Page): Promise<void> {
    const saveBtn = page.getByRole("button", { name: "Save changes" });

    // Wait for the button to appear
    try {
      await saveBtn.waitFor({ state: "visible", timeout: 5000 });
    } catch {
      logger.warn("Save changes button never became visible");
      return;
    }

    // Wait up to 5s for it to become enabled (the form enables it once it detects dirty fields)
    for (let i = 0; i < 10; i++) {
      if (!(await saveBtn.isDisabled().catch(() => true))) break;
      await page.waitForTimeout(500);
    }

    // Strategy 1: normal Playwright click
    try {
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click({ timeout: 3000 });
      logger.info("Clicked Save changes");
      await stepPause();
      return;
    } catch {
      logger.debug("Normal click failed, trying force click");
    }

    // Strategy 2: force click (ignores actionability checks)
    try {
      await saveBtn.click({ force: true, timeout: 3000 });
      logger.info("Clicked Save changes (force)");
      await stepPause();
      return;
    } catch {
      logger.debug("Force click failed, trying JS dispatch");
    }

    // Strategy 3: JS — find the button, remove disabled if present, dispatch a real click event
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
      const btn = buttons.find((b) => b.textContent?.trim() === "Save changes");
      if (!btn) return false;
      btn.removeAttribute("disabled");
      btn.click();
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    });
    if (clicked) {
      logger.info("Clicked Save changes (JS dispatch)");
      await stepPause();
    } else {
      logger.warn("Save changes button not found in DOM");
    }
  }

  /**
   * After uploading a profile picture, Whop shows a crop modal (fui-DialogOverlay).
   * Click Save inside that modal; the main form Save is behind the overlay so we
   * must target the button inside the portal/dialog.
   */
  private async saveCropModal(page: Page): Promise<void> {
    // Wait for the crop modal to appear (overlay or dialog in a portal)
    await page.waitForTimeout(1500);

    // Try 1: Save button inside a dialog role
    let saveInModal = page.locator('[role="dialog"]').locator('button:has-text("Save")').first();
    if (await saveInModal.isVisible().catch(() => false)) {
      await saveInModal.click();
      logger.info("Clicked Save in crop modal (dialog)");
      await page.waitForTimeout(2000);
      return;
    }

    // Try 2: Save inside the portal (Whop uses data-base-ui-portal; overlay intercepts main page)
    saveInModal = page.locator('[data-base-ui-portal]').locator('button:has-text("Save")').first();
    if (await saveInModal.isVisible().catch(() => false)) {
      await saveInModal.click();
      logger.info("Clicked Save in crop modal (portal)");
      await page.waitForTimeout(2000);
      return;
    }

    // Try 3: Any visible Save that's in an overlay/dialog context
    saveInModal = page.locator('[class*="DialogOverlay"], [class*="Modal"]').locator('..').locator('button:has-text("Save")').first();
    if (await saveInModal.isVisible().catch(() => false)) {
      await saveInModal.click();
      logger.info("Clicked Save in crop modal (overlay parent)");
      await page.waitForTimeout(2000);
      return;
    }

    logger.debug("No crop modal Save button found, continuing");
  }

  /**
   * Navigate to the target community and join it.
   */
  async joinCommunity(page: Page, communityUrl: string): Promise<void> {
    logger.info(`Navigating to community: ${communityUrl}`);
    await page.goto(communityUrl, { waitUntil: "networkidle", timeout: 30000 });
    await stepPause();
    await this.dismissPopups(page);

    const joinBtn = page.locator(
      'button:has-text("Join"), button:has-text("Get Access"), button:has-text("Subscribe"), a:has-text("Join"), a:has-text("Get Access")',
    ).first();

    if (await joinBtn.isVisible().catch(() => false)) {
      await joinBtn.click();
      logger.info("Clicked join/access button");
      await stepPause();

      const confirmBtn = page.locator(
        'button:has-text("Join"), button:has-text("Confirm"), button:has-text("Get Access"), button:has-text("Continue")',
      ).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await stepPause();
      }

      logger.info("Joined community successfully");
    } else {
      logger.warn("No join button found — page may need manual interaction or bot is already a member");
    }
  }

  /**
   * Navigate to the product page URL and click the Join button.
   */
  async joinProduct(page: Page, productUrl: string): Promise<boolean> {
    logger.info(`Navigating to product: ${productUrl}`);
    await page.goto(productUrl, { waitUntil: "networkidle", timeout: 30000 });
    await stepPause();
    await this.dismissPopups(page);

    const joinBtn = page.locator(
      'button:has-text("Join"), button:has-text("Join for free"), a:has-text("Join"), a:has-text("Join for free")',
    ).first();

    if (await joinBtn.isVisible().catch(() => false)) {
      await joinBtn.scrollIntoViewIfNeeded().catch(() => {});
      await joinBtn.click();
      logger.info("Clicked product Join button");
      await stepPause();

      const confirmBtn = page.locator(
        'button:has-text("Join"), button:has-text("Confirm"), button:has-text("Continue"), button:has-text("Get Access")',
      ).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await stepPause();
      }

      await this.dismissPopups(page);
      logger.info("Joined product successfully");
      return true;
    }

    logger.warn("No Join button found on the product page");
    return false;
  }

  /**
   * Navigate to the community home and like the top comment/post.
   * Whop shows "Like" / "Liked" in a span with class fui-Text; we click the button that says "Like".
   */
  async likeTopComment(page: Page, communityUrl: string): Promise<boolean> {
    logger.info("Navigating to community home to like top comment...");
    await page.goto(communityUrl, { waitUntil: "networkidle", timeout: 30000 });
    await stepPause();
    await this.dismissPopups(page);

    // Whop: like button contains <span class="fui-Text ...">Like</span> (or "Liked" after click). Click the one that says "Like".
    const likeBtn = page.locator('button').filter({
      has: page.locator('span.fui-Text').filter({ hasText: /^Like$/ }),
    }).first();

    if (await likeBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await likeBtn.scrollIntoViewIfNeeded().catch(() => {});
      await likeBtn.click();
      logger.info("Liked top comment (fui-Text Like button)");
      await humanPause();
      return true;
    }

    // Fallback: role button with name "Like" (exact)
    const likeByRole = page.getByRole("button", { name: "Like" }).first();
    if (await likeByRole.isVisible({ timeout: 2000 }).catch(() => false)) {
      await likeByRole.scrollIntoViewIfNeeded().catch(() => {});
      await likeByRole.click();
      logger.info("Liked top comment (getByRole)");
      await humanPause();
      return true;
    }

    logger.warn("Could not find a like button on the community page");
    return false;
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      logger.info("Browser closed");
    }
  }
}
