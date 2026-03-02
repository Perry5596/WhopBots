import { ImapFlow } from "imapflow";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/delay.js";

export interface GmailConfig {
  address: string;
  appPassword?: string;
}

export function generateDotVariations(
  gmailAddress: string,
  count: number,
  offset = 0,
): string[] {
  const [localRaw, domain] = gmailAddress.split("@");
  const local = localRaw.replace(/\./g, "");
  const gaps = local.length - 1;
  const totalVariations = 2 ** gaps;

  if (offset + count > totalVariations) {
    throw new Error(
      `Cannot generate ${count} variations (offset=${offset}). ` +
      `"${local}" only supports ${totalVariations} dot permutations total.`,
    );
  }

  const results: string[] = [];
  for (let mask = offset; mask < offset + count; mask++) {
    let addr = "";
    for (let i = 0; i < local.length; i++) {
      addr += local[i];
      if (i < gaps && (mask >> i) & 1) {
        addr += ".";
      }
    }
    results.push(`${addr}@${domain}`);
  }

  return results;
}

export function maxVariations(gmailAddress: string): number {
  const local = gmailAddress.split("@")[0].replace(/\./g, "");
  return 2 ** (local.length - 1);
}

/**
 * Extract a 6-digit code from a subject line.
 * Whop subjects start with the code: "402372 is your Whop sign-in code"
 */
function extractCode(subject: string): string | null {
  const trimmed = subject.trim();
  // Primary: first 6 chars are the code
  if (trimmed.length >= 6 && /^\d{6}/.test(trimmed)) {
    return trimmed.slice(0, 6);
  }
  // Fallback: any 6-digit number in the subject
  const match = trimmed.match(/\b(\d{6})\b/);
  return match ? match[1] : null;
}

/**
 * Poll Gmail IMAP for the Whop sign-in code.
 *
 * Strategy: one persistent IMAP connection, poll INBOX every 3 seconds,
 * look at ALL recent emails, find the newest Whop code email that arrived
 * after signupTime. Uses sequence numbers (not UIDs) and the NOOP command
 * to refresh the mailbox between polls.
 */
export async function waitForVerificationCode(
  gmail: Required<GmailConfig>,
  _targetAddress: string,
  signupTime: number,
  timeoutMs = 90_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  logger.info("Connecting to Gmail IMAP...");

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: gmail.address, pass: gmail.appPassword },
    tls: { rejectUnauthorized: false },
    logger: false as any,
    emitLogs: false,
  });

  try {
    await client.connect();
    logger.info("IMAP connected, opening INBOX");

    const lock = await client.getMailboxLock("INBOX");
    try {
      let pollCount = 0;

      while (Date.now() < deadline) {
        pollCount++;

        // Tell the server to update its state (new emails become visible)
        await client.noop();

        // How many messages in the inbox?
        const status = await client.status("INBOX", { messages: true });
        const total = status.messages ?? 0;

        if (total === 0) {
          logger.debug(`Poll #${pollCount}: inbox empty, waiting...`);
          await sleep(3000);
          continue;
        }

        // Only look at the last 20 messages (newest first)
        const startSeq = Math.max(1, total - 19);
        const range = `${startSeq}:${total}`;

        logger.debug(`Poll #${pollCount}: checking messages ${range} (${total} total)`);

        // Collect results from the async iterator safely
        const results: { seq: number; subject: string; date: Date | null }[] = [];
        try {
          const iter = client.fetch(range, { envelope: true });
          for await (const msg of iter) {
            const subject = msg.envelope?.subject ?? "";
            const date = msg.envelope?.date ? new Date(msg.envelope.date) : null;
            results.push({ seq: msg.seq, subject, date });
          }
        } catch (fetchErr) {
          logger.warn(`Fetch error during poll #${pollCount}: ${fetchErr}`);
          await sleep(3000);
          continue;
        }

        // Scan newest-first for a Whop code email sent after signup
        results.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));

        for (const r of results) {
          const subLower = r.subject.toLowerCase();
          if (!subLower.includes("whop")) continue;

          // Must have arrived after signup (with 15s tolerance)
          if (r.date && r.date.getTime() < signupTime - 15_000) {
            logger.debug(`Skipping old Whop email: "${r.subject}" (${r.date.toISOString()})`);
            continue;
          }

          const code = extractCode(r.subject);
          if (code) {
            logger.info(`Found code ${code} in: "${r.subject}"`);
            return code;
          }

          logger.debug(`Whop email but no code: "${r.subject}"`);
        }

        logger.debug(`Poll #${pollCount}: no matching code yet, waiting 3s...`);
        await sleep(3000);
      }

      throw new Error("Timed out waiting for Whop sign-in code");
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
    logger.debug("IMAP disconnected");
  }
}
