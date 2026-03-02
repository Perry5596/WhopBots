import { logger } from "./utils/logger.js";
import { botGapPause, sleep } from "./utils/delay.js";
import { prompt } from "./utils/prompt.js";
import { generateDotVariations } from "./services/email.js";
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
      // 1. Submit email on Whop login page
      const page = await this.automator.submitEmail(context, email);
      this.storage.updateStatus(botId, "created");

      // 2. Ask the user to enter the code from their email
      console.log("");
      const code = await prompt("  Enter the 6-digit sign-in code from your email: ");

      if (!/^\d{6}$/.test(code)) {
        throw new Error(`Invalid code "${code}" — must be exactly 6 digits`);
      }

      // 3. Enter the code on the page
      await this.automator.enterVerificationCode(page, code);
      this.storage.updateStatus(botId, "verified");

      // 4. Navigate to profile settings and update name/username/picture
      await this.automator.updateProfile(page, profile, picturePath);
      this.storage.updateStatus(botId, "profile_set");

      // 5. Join community
      if (this.config.communityUrl) {
        await this.automator.joinCommunity(page, this.config.communityUrl);
        this.storage.updateStatus(botId, "joined");
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
      this.storage.updateStatus(botId, "created");

      const code = await prompt("  Enter the 6-digit sign-in code from your email: ");
      if (!/^\d{6}$/.test(code)) {
        throw new Error(`Invalid code "${code}" — must be exactly 6 digits`);
      }

      await this.automator.enterVerificationCode(page, code);
      this.storage.updateStatus(botId, "verified");

      await this.automator.updateProfile(page, profile, picturePath);
      this.storage.updateStatus(botId, "profile_set");

      if (bot.communityUrl) {
        await this.automator.joinCommunity(page, bot.communityUrl);
        this.storage.updateStatus(botId, "joined");
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
