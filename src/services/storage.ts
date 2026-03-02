import Database from "better-sqlite3";
import { logger } from "../utils/logger.js";

export type BotStatus = "created" | "verified" | "profile_set" | "joined" | "failed";

export interface BotRecord {
  id: number;
  email: string;
  emailPassword: string;
  accountPassword: string;
  firstName: string;
  lastName: string;
  username: string;
  communityUrl: string;
  status: BotStatus;
  errorMessage: string | null;
  createdAt: string;
}

export class BotStorage {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        email           TEXT NOT NULL,
        email_password  TEXT NOT NULL,
        account_password TEXT NOT NULL,
        first_name      TEXT NOT NULL,
        last_name       TEXT NOT NULL,
        username        TEXT NOT NULL,
        community_url   TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'created',
        error_message   TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    logger.debug("Bot storage initialized");
  }

  insertBot(bot: {
    email: string;
    emailPassword: string;
    accountPassword: string;
    firstName: string;
    lastName: string;
    username: string;
    communityUrl: string;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO bots (email, email_password, account_password, first_name, last_name, username, community_url)
      VALUES (@email, @emailPassword, @accountPassword, @firstName, @lastName, @username, @communityUrl)
    `);
    const result = stmt.run(bot);
    return Number(result.lastInsertRowid);
  }

  updateStatus(id: number, status: BotStatus, errorMessage?: string): void {
    this.db.prepare(`
      UPDATE bots SET status = ?, error_message = ? WHERE id = ?
    `).run(status, errorMessage ?? null, id);
  }

  getAllBots(): BotRecord[] {
    return this.db.prepare("SELECT * FROM bots ORDER BY id DESC").all() as BotRecord[];
  }

  getBotsByStatus(status: BotStatus): BotRecord[] {
    return this.db
      .prepare("SELECT * FROM bots WHERE status = ? ORDER BY id DESC")
      .all(status) as BotRecord[];
  }

  getBot(id: number): BotRecord | undefined {
    return this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRecord | undefined;
  }

  close(): void {
    this.db.close();
  }
}
