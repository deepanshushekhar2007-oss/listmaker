import fs from "fs";
import path from "path";
import { logger } from "../lib/logger.js";

const DATA_FILE = path.resolve("bot_data.json");

interface BotData {
  accessMode: boolean;
  accessList: Record<string, number>;
  banList: string[];
}

let data: BotData = {
  accessMode: false,
  accessList: {},
  banList: [],
};

export function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      data = JSON.parse(raw);
      logger.info("Bot data loaded from disk");
    }
  } catch (err) {
    logger.warn({ err }, "Could not load bot_data.json, starting fresh");
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.error({ err }, "Could not save bot_data.json");
  }
}

export function getAdminId(): number | null {
  const id = process.env.ADMIN_ID;
  if (!id) return null;
  const n = parseInt(id, 10);
  return isNaN(n) ? null : n;
}

export function isAdmin(userId: number): boolean {
  return userId === getAdminId();
}

export function isAccessModeOn(): boolean {
  return data.accessMode;
}

export function setAccessMode(on: boolean) {
  data.accessMode = on;
  saveData();
}

export function isBanned(userId: number): boolean {
  return data.banList.includes(String(userId));
}

export function grantAccess(userId: number, days: number) {
  const expiry = days === 0 ? 0 : Date.now() + days * 24 * 60 * 60 * 1000;
  data.accessList[String(userId)] = expiry;
  data.banList = data.banList.filter((id) => id !== String(userId));
  saveData();
}

export function revokeAccess(userId: number) {
  delete data.accessList[String(userId)];
  saveData();
}

export function banUser(userId: number) {
  if (!data.banList.includes(String(userId))) {
    data.banList.push(String(userId));
  }
  delete data.accessList[String(userId)];
  saveData();
}

export function unbanUser(userId: number) {
  data.banList = data.banList.filter((id) => id !== String(userId));
  saveData();
}

export function hasAccess(userId: number): boolean {
  if (isAdmin(userId)) return true;
  if (isBanned(userId)) return false;
  if (!data.accessMode) return true;

  const expiry = data.accessList[String(userId)];
  if (expiry === undefined) return false;
  if (expiry === 0) return true;
  return Date.now() < expiry;
}

export function getStatusText(): string {
  const mode = data.accessMode ? "🟢 ON (only approved users)" : "🔴 OFF (everyone can use)";
  const now = Date.now();

  const accessEntries = Object.entries(data.accessList);
  let accessLines = "";
  if (accessEntries.length === 0) {
    accessLines = " None";
  } else {
    accessLines = accessEntries
      .map(([uid, exp]) => {
        if (exp === 0) return ` • ${uid} — Permanent`;
        if (now > exp) return ` • ${uid} — ❌ Expired`;
        const days = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
        return ` • ${uid} — ${days} day${days !== 1 ? "s" : ""} left`;
      })
      .join("\n");
  }

  const banLines =
    data.banList.length === 0
      ? " None"
      : data.banList.map((id) => ` • ${id}`).join("\n");

  return (
    `⚙️ *Bot Status*\n\n` +
    `*Subscription Mode:* ${mode}\n\n` +
    `*Users with Access (${accessEntries.length}):*\n${accessLines}\n\n` +
    `*Banned Users (${data.banList.length}):*\n${banLines}`
  );
}

export const ADMIN_HELP = `🛠 *Admin Commands*

/access on — Enable subscription mode
/access off — Disable subscription mode
/access [user\\_id] [days] — Give user access (0 days = permanent)
/ban [user\\_id] — Ban a user
/unban [user\\_id] — Unban a user
/revoke [user\\_id] — Remove user's access
/status — Show full bot status
/admin — Show this help`;
