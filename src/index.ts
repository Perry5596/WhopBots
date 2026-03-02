#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { BotManager } from "./bot-manager.js";
import { defaultConfig, type AppConfig } from "./config.js";
import { maxVariations } from "./services/email.js";

function env(key: string): string {
  return process.env[key] ?? "";
}

const program = new Command();

program
  .name("whopbots")
  .description("Automated Whop bot account creator")
  .version("1.0.0");

program
  .command("create")
  .description("Create bot accounts and join a Whop community")
  .option("-c, --community <url>", "Whop community URL to join")
  .option("-g, --gmail <address>", "Gmail address (e.g. johnsmith@gmail.com)")
  .option("-n, --count <number>", "Number of bots to create", "1")
  .option("--delay <ms>", "Delay between bots in milliseconds", "10000")
  .option("--no-headless", "Run browser in visible mode (for debugging)")
  .action(async (opts) => {
    const gmail = opts.gmail || env("GOOGLE_EMAIL");
    const community = opts.community || env("WHOP_COMMUNITY_URL");

    if (!gmail || !community) {
      console.error("Error: Missing required values. Provide via CLI flags or .env file:");
      if (!gmail) console.error("  - Gmail address (-g or GOOGLE_EMAIL)");
      if (!community) console.error("  - Community URL (-c or WHOP_COMMUNITY_URL)");
      process.exit(1);
    }

    const count = parseInt(opts.count, 10);
    const max = maxVariations(gmail);
    if (count > max) {
      console.error(
        `Error: Gmail address "${gmail}" only supports ${max} dot-trick variations, ` +
        `but you requested ${count} bots. Use a longer Gmail username for more capacity.`,
      );
      process.exit(1);
    }

    const config: AppConfig = {
      ...defaultConfig,
      communityUrl: community,
      count,
      concurrency: 1,
      delayBetweenBotsMs: parseInt(opts.delay, 10),
      headless: opts.headless !== false,
      gmail: { address: gmail },
    };

    const manager = new BotManager(config);
    const result = await manager.createBots();
    process.exit(result.failed > 0 ? 1 : 0);
  });

program
  .command("list")
  .description("List all created bot accounts and their statuses")
  .action(() => {
    const manager = new BotManager({
      ...defaultConfig,
      communityUrl: "",
      gmail: { address: "" },
    });
    manager.listBots();
  });

program
  .command("retry-failed")
  .description("Retry all previously failed bot creations")
  .option("-c, --community <url>", "Whop community URL to join")
  .option("-g, --gmail <address>", "Gmail address")
  .option("--delay <ms>", "Delay between retries in milliseconds", "10000")
  .option("--no-headless", "Run browser in visible mode")
  .action(async (opts) => {
    const gmail = opts.gmail || env("GOOGLE_EMAIL");
    const community = opts.community || env("WHOP_COMMUNITY_URL");

    if (!gmail || !community) {
      console.error("Error: Missing required values. Provide via CLI flags or .env file:");
      if (!gmail) console.error("  - Gmail address (-g or GOOGLE_EMAIL)");
      if (!community) console.error("  - Community URL (-c or WHOP_COMMUNITY_URL)");
      process.exit(1);
    }

    const config: AppConfig = {
      ...defaultConfig,
      communityUrl: community,
      count: 0,
      delayBetweenBotsMs: parseInt(opts.delay, 10),
      headless: opts.headless !== false,
      gmail: { address: gmail },
    };

    const manager = new BotManager(config);
    const result = await manager.retryFailed();
    process.exit(result.failed > 0 ? 1 : 0);
  });

program
  .command("info")
  .description("Show how many bot variations your Gmail address supports")
  .option("-g, --gmail <address>", "Gmail address")
  .action((opts) => {
    const gmail = opts.gmail || env("GOOGLE_EMAIL");
    if (!gmail) {
      console.error("Error: Provide a Gmail address via -g or GOOGLE_EMAIL in .env");
      process.exit(1);
    }
    const max = maxVariations(gmail);
    const local = gmail.split("@")[0].replace(/\./g, "");
    console.log(`\nGmail: ${gmail}`);
    console.log(`Username (dots stripped): ${local} (${local.length} chars)`);
    console.log(`Maximum dot-trick variations: ${max}`);
    console.log(`\nThis means you can create up to ${max} bot accounts with this Gmail.\n`);
  });

program.parse();
