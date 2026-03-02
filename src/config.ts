import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GmailCredentials {
  address: string;
}

export interface AppConfig {
  communityUrl: string;
  count: number;
  concurrency: number;
  delayBetweenBotsMs: number;
  headless: boolean;
  dbPath: string;
  tempDir: string;
  gmail: GmailCredentials;
}

export const defaultConfig: Omit<AppConfig, "communityUrl" | "gmail"> = {
  count: 1,
  concurrency: 1,
  delayBetweenBotsMs: 10000,
  headless: true,
  dbPath: path.resolve(__dirname, "..", "whopbots.db"),
  tempDir: path.resolve(__dirname, "..", "temp"),
};
