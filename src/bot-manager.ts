import { logger } from "./utils/logger.js";
import { botGapPause, sleep } from "./utils/delay.js";
import { prompt } from "./utils/prompt.js";
import { withRetry } from "./utils/retry.js";
import { generateDotVariations, waitForVerificationCode } from "./services/email.js";
import { generateProfile, downloadProfilePicture } from "./services/profile.js";
import { BotStorage } from "./services/storage.js";
import { WhopAutomator } from "./services/whop.js";
import type { AppConfig } from "./config.js";
import fs from "fs";

export interface CreateBotsResult {
  total: number;
  succeeded: number;
  failed: number;
}

export class BotManager {
  private storage: BotStorage;
  private automator: WhopAutomator;
  private config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.storage = new BotStorage(config.dbPath);
    this.automator = new WhopAutomator({ headless: config.headless });
  }

  async createBots(): Promise<CreateBotsResult> {
    const result: CreateBotsResult = { total: this.config.count, succeeded: 0, failed: 0 };

    const existingBots = this.storage.getAllBots().filter(
      (b) => b.email.split("@")[1] === this.config.gmail.address.split("@")[1],
    );
    const offset = existingBots.length;

    const emails = generateDotVariations(this.config.gmail.address, this.config.count, offset);
    logger.info(`Generated ${emails.length} Gmail dot-trick addresses (offset=${offset})`);

    await this.automator.launch();

    try {
      for (let i = 0; i < this.config.count; i++) {
        // Restart browser every 3 bots to avoid memory buildup and rate limiting
        if (i > 0 && i % 3 === 0) {
          logger.info("Restarting browser (every 3 bots) to stay stable...");
          await this.automator.close();
          await sleep(3000);
          await this.automator.launch();
        }

        console.log(`\n${"=".repeat(50)}`);
        console.log(`  Bot ${i + 1} of ${this.config.count}`);
        console.log(`${"=".repeat(50)}`);

        try {
          await this.createSingleBot(emails[i]);
          result.succeeded++;
        } catch (err) {
          result.failed++;
          logger.error(`Bot ${i + 1} failed: ${err}`);
        }

        if (i < this.config.count - 1) {
          logger.info("Waiting before next bot...");
          await sleep(this.config.delayBetweenBotsMs);
          await botGapPause();
          // Extra cooldown after every 3 bots to reduce rate limiting
          if ((i + 1) % 3 === 0) {
            const extraMs = 30_000 + Math.floor(Math.random() * 30_000);
            logger.info(`Extended cooldown (${Math.round(extraMs / 1000)}s) after batch of 3...`);
            await sleep(extraMs);
          }
        }
      }
    } finally {
      await this.automator.close();
      this.storage.close();
    }

    console.log(`\nDone! ${result.succeeded} succeeded, ${result.failed} failed out of ${result.total}`);
    return result;
  }

  private async createSingleBot(email: string): Promise<void> {
    const profile = generateProfile();
    console.log(`  Name:     ${profile.displayName}`);
    console.log(`  Username: @${profile.username}`);
    console.log(`  Picture:  ${profile.hasProfilePicture ? "yes" : "no"}`);
    console.log(`  Email:    ${email}`);

    let picturePath: string | null = null;
    if (profile.hasProfilePicture) {
      picturePath = await downloadProfilePicture(this.config.tempDir);
    }

    const botId = this.storage.insertBot({
      email,
      emailPassword: "",
      accountPassword: profile.password,
      firstName: profile.firstName,
      lastName: profile.lastName,
      username: profile.username,
      communityUrl: this.config.communityUrl,
    });

    const context = await this.automator.newContext();
    try {
      // 1. Submit email on Whop login page and record time for "email after this"
      const page = await this.automator.submitEmail(context, email);
      const signupTime = Date.now();
      this.storage.updateStatus(botId, "created");

      // 2. Get 6-digit code: auto from Gmail (if app password set) or manual prompt, with fallback
      let code: string;
      const gmailWithPassword = this.config.gmail.address && this.config.gmail.appPassword
        ? { address: this.config.gmail.address, appPassword: this.config.gmail.appPassword }
        : null;

      const getCode = async (): Promise<string> => {
        if (gmailWithPassword) {
          try {
            return await withRetry(
              () => waitForVerificationCode(gmailWithPassword, email, signupTime, 90_000),
              { label: "wait-for-2fa-code", maxAttempts: 2, baseDelayMs: 3000 },
            );
          } catch (err) {
            logger.warn(`Auto 2FA failed (${err}), falling back to manual entry`);
          }
        }
        console.log("");
        const manual = await prompt("  Enter the 6-digit sign-in code from your email: ");
        if (!/^\d{6}$/.test(manual)) {
          throw new Error(`Invalid code "${manual}" — must be exactly 6 digits`);
        }
        return manual;
      };

      code = await getCode();

      // 3. Enter the code on the page; if it fails and we have auto 2FA, try once more with a fresh code
      try {
        await this.automator.enterVerificationCode(page, code);
      } catch (enterErr) {
        if (gmailWithPassword) {
          logger.warn("Code entry failed, fetching a fresh code and retrying...");
          code = await waitForVerificationCode(gmailWithPassword, email, signupTime, 30_000);
          await this.automator.enterVerificationCode(page, code);
        } else {
          throw enterErr;
        }
      }

      this.storage.updateStatus(botId, "verified");

      // 4. Navigate to profile settings and update name/username/picture
      await this.automator.updateProfile(page, profile, picturePath);
      this.storage.updateStatus(botId, "profile_set");

      // 5. Join community
      if (this.config.communityUrl) {
        await this.automator.joinCommunity(page, this.config.communityUrl);
        this.storage.updateStatus(botId, "joined");

        // 6. 70% chance: like the top comment on the community home first (more efficient)
        if (Math.random() < 0.7) {
          await this.automator.likeTopComment(page, this.config.communityUrl);
        }

        // 7. Then go to the product page and join (if product URL is set)
        if (this.config.productUrl) {
          await this.automator.joinProduct(page, this.config.productUrl);
        }
      }

      console.log(`  Bot ${botId} completed successfully!\n`);
    } catch (err) {
      this.storage.updateStatus(botId, "failed", String(err));
      throw err;
    } finally {
      await context.close();
      if (picturePath != null) {
        try { fs.unlinkSync(picturePath); } catch { /* ignore */ }
      }
    }
  }

  async retryFailed(): Promise<CreateBotsResult> {
    const failedBots = this.storage.getBotsByStatus("failed");
    if (!failedBots.length) {
      console.log("No failed bots to retry.");
      return { total: 0, succeeded: 0, failed: 0 };
    }

    console.log(`Retrying ${failedBots.length} failed bot(s)...\n`);
    const result: CreateBotsResult = { total: failedBots.length, succeeded: 0, failed: 0 };

    await this.automator.launch();

    try {
      for (const bot of failedBots) {
        console.log(`\nRetrying bot id=${bot.id} (${bot.email})`);
        try {
          await this.retrySingleBot(bot.id);
          result.succeeded++;
        } catch (err) {
          result.failed++;
          logger.error(`Retry for bot ${bot.id} failed: ${err}`);
        }

        await sleep(this.config.delayBetweenBotsMs);
      }
    } finally {
      await this.automator.close();
      this.storage.close();
    }

    return result;
  }

  private async retrySingleBot(botId: number): Promise<void> {
    const bot = this.storage.getBot(botId);
    if (!bot) throw new Error(`Bot ${botId} not found`);

    const displayName = [bot.firstName, bot.lastName].filter(Boolean).join(" ").trim() || bot.firstName;
    const profile = {
      firstName: bot.firstName,
      lastName: bot.lastName,
      displayName,
      username: bot.username,
      dateOfBirth: "2000-01-15",
      password: bot.accountPassword,
      hasProfilePicture: true,
    };

    const picturePath = await downloadProfilePicture(this.config.tempDir);
    const context = await this.automator.newContext();

    try {
      const page = await this.automator.submitEmail(context, bot.email);
      const signupTime = Date.now();
      this.storage.updateStatus(botId, "created");

      const gmailWithPassword = this.config.gmail.appPassword
        ? { address: this.config.gmail.address, appPassword: this.config.gmail.appPassword }
        : null;

      let code: string;
      if (gmailWithPassword) {
        try {
          code = await waitForVerificationCode(gmailWithPassword, bot.email, signupTime, 90_000);
        } catch (err) {
          logger.warn(`Auto 2FA failed (${err}), falling back to manual entry`);
          const manual = await prompt("  Enter the 6-digit sign-in code from your email: ");
          if (!/^\d{6}$/.test(manual)) throw new Error(`Invalid code — must be exactly 6 digits`);
          code = manual;
        }
      } else {
        const manual = await prompt("  Enter the 6-digit sign-in code from your email: ");
        if (!/^\d{6}$/.test(manual)) throw new Error(`Invalid code — must be exactly 6 digits`);
        code = manual;
      }

      try {
        await this.automator.enterVerificationCode(page, code);
      } catch (enterErr) {
        if (gmailWithPassword) {
          logger.warn("Fetching a fresh code and retrying...");
          code = await waitForVerificationCode(gmailWithPassword, bot.email, signupTime, 30_000);
          await this.automator.enterVerificationCode(page, code);
        } else {
          throw enterErr;
        }
      }

      this.storage.updateStatus(botId, "verified");

      await this.automator.updateProfile(page, profile, picturePath);
      this.storage.updateStatus(botId, "profile_set");

      if (bot.communityUrl) {
        await this.automator.joinCommunity(page, bot.communityUrl);
        this.storage.updateStatus(botId, "joined");

        if (Math.random() < 0.7) {
          await this.automator.likeTopComment(page, bot.communityUrl);
        }

        if (this.config.productUrl) {
          await this.automator.joinProduct(page, this.config.productUrl);
        }
      }

      console.log(`  Bot ${botId} retry succeeded!\n`);
    } catch (err) {
      this.storage.updateStatus(botId, "failed", String(err));
      throw err;
    } finally {
      await context.close();
      if (picturePath) {
        try { fs.unlinkSync(picturePath); } catch { /* ignore */ }
      }
    }
  }

  listBots(): void {
    const bots = this.storage.getAllBots();
    if (!bots.length) {
      console.log("No bots created yet.");
      return;
    }

    console.log(`\n  ${"ID".padEnd(5)} ${"Email".padEnd(35)} ${"Name".padEnd(25)} ${"Status".padEnd(14)} Created`);
    console.log("  " + "-".repeat(100));
    for (const b of bots) {
      console.log(
        `  ${String(b.id).padEnd(5)} ${b.email.padEnd(35)} ${[b.firstName, b.lastName].filter(Boolean).join(" ").padEnd(25)} ${b.status.padEnd(14)} ${b.createdAt}`,
      );
      if (b.errorMessage) {
        console.log(`        Error: ${b.errorMessage}`);
      }
    }
    console.log();
    this.storage.close();
  }
}
