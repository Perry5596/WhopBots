import { faker } from "@faker-js/faker";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

export interface BotProfile {
  firstName: string;
  lastName: string;
  displayName: string; // What shows in the name field (may differ from first+last)
  username: string;
  dateOfBirth: string;
  password: string;
  hasProfilePicture: boolean;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChance(percent: number): boolean {
  return Math.random() * 100 < percent;
}

/**
 * Generate a display name. ~55% full person name, ~25% first name only, ~20% creative/username-style.
 */
function generateDisplayName(): { displayName: string; firstName: string; lastName: string } {
  const roll = Math.random() * 100;

  if (roll < 55) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    return { displayName: `${firstName} ${lastName}`, firstName, lastName };
  }

  if (roll < 80) {
    const firstName = faker.person.firstName();
    return { displayName: firstName, firstName, lastName: "" };
  }

  // Creative/username-style names
  const styles = [
    () => faker.internet.userName().replace(/[^a-zA-Z0-9]/g, ""),
    () => `${faker.word.adjective()}${faker.word.noun()}`.replace(/[^a-zA-Z]/g, ""),
    () => `${faker.animal.type()}${randomInt(1, 999)}`,
    () => `${faker.color.human()}${faker.animal.type()}`.replace(/[^a-zA-Z]/g, ""),
    () => `x${faker.word.noun()}${faker.word.noun()}x`.replace(/[^a-zA-Z0-9]/g, ""),
    () => `${faker.person.firstName()}${randomInt(10, 99)}`,
  ];
  const pick = styles[randomInt(0, styles.length - 1)]();
  const displayName = pick.charAt(0).toUpperCase() + pick.slice(1).toLowerCase();
  return { displayName, firstName: displayName, lastName: "" };
}

export function generateProfile(): BotProfile {
  const { displayName, firstName, lastName } = generateDisplayName();

  const usernameBase =
    lastName
      ? `${firstName}${lastName}`.replace(/[^a-zA-Z]/g, "").toLowerCase()
      : `${firstName}`.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const suffix = randomInt(1000, 999999);
  const username = `${usernameBase}${suffix}`;

  const age = randomInt(18, 45);
  const now = new Date();
  const birthYear = now.getFullYear() - age;
  const birthMonth = randomInt(1, 12);
  const birthDay = randomInt(1, 28);
  const dateOfBirth = `${birthYear}-${String(birthMonth).padStart(2, "0")}-${String(birthDay).padStart(2, "0")}`;

  const password =
    faker.internet.password({ length: 14, memorable: false }) +
    randomInt(10, 99) +
    "!";

  const hasProfilePicture = randomChance(70);

  logger.debug(`Generated profile: ${displayName} (@${username}) pic=${hasProfilePicture}`);
  return {
    firstName,
    lastName,
    displayName,
    username,
    dateOfBirth,
    password,
    hasProfilePicture,
  };
}

/**
 * Download a profile picture. 60% AI face, 40% random avatar.
 * Returns the file path, or null if no picture should be used.
 */
export async function downloadProfilePicture(
  tempDir: string,
  type?: "person" | "avatar",
): Promise<string | null> {
  const usePerson = type ?? (randomChance(60) ? "person" : "avatar");

  fs.mkdirSync(tempDir, { recursive: true });
  const ext = usePerson === "person" ? "jpg" : "png";
  const filePath = path.join(tempDir, `avatar_${Date.now()}_${randomInt(1000, 9999)}.${ext}`);

  if (usePerson === "person") {
    await withRetry(
      async () => {
        const res = await fetch("https://thispersondoesnotexist.com/", {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        });
        if (!res.ok) throw new Error(`Face download failed: ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
      },
      { label: "download-face", maxAttempts: 3 },
    );
    logger.info(`Downloaded profile picture (person) → ${filePath}`);
  } else {
    const seed = `avatar_${Date.now()}_${randomInt(1000, 99999)}`;
    const avatarStyles = ["avataaars", "lorelei", "notionists", "fun-emoji"];
    const style = avatarStyles[randomInt(0, avatarStyles.length - 1)];
    await withRetry(
      async () => {
        const res = await fetch(
          `https://api.dicebear.com/7.x/${style}/png?seed=${seed}&size=256`,
          { headers: { "User-Agent": "WhopBots/1.0" } },
        );
        if (!res.ok) throw new Error(`Avatar download failed: ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
      },
      { label: "download-avatar", maxAttempts: 3 },
    );
    logger.info(`Downloaded profile picture (avatar) → ${filePath}`);
  }

  return filePath;
}
