import TelegramBot from "node-telegram-bot-api";
import { extractGroupDataFromImage, type GroupEntry } from "./gemini.js";
import { extractLinks, parseBaseName, buildOutput } from "./whatsapp.js";
import { logger } from "../lib/logger.js";
import {
  loadData, isAdmin, isAccessModeOn, setAccessMode,
  isBanned, grantAccess, revokeAccess, banUser, unbanUser,
  hasAccess, getStatusText, ADMIN_HELP, getAdminId,
} from "./admin.js";

type UserState =
  | { mode: "idle" }
  | { mode: "screenshots"; entries: GroupEntry[]; queue: string[]; processing: boolean }
  | { mode: "wa_links"; links: string[] }
  | { mode: "wa_name"; links: string[] }
  | { mode: "wa_exclusions"; links: string[]; prefix: string; startNum: number };

const sessions = new Map<number, UserState>();
const mediaGroupBuffers = new Map<string, { chatId: number; userId: number; fileIds: string[]; timer: ReturnType<typeof setTimeout> }>();

function getState(userId: number): UserState {
  return sessions.get(userId) ?? { mode: "idle" };
}
function setState(userId: number, state: UserState) {
  sessions.set(userId, state);
}

const FORCE_SUB_CHANNEL = process.env.FORCE_SUB_CHANNEL ?? "";

async function isSubscribed(bot: TelegramBot, userId: number): Promise<boolean> {
  if (!FORCE_SUB_CHANNEL) return true;
  try {
    const member = await bot.getChatMember(FORCE_SUB_CHANNEL, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

async function sendJoinMessage(bot: TelegramBot, chatId: number): Promise<void> {
  const channelLink = FORCE_SUB_CHANNEL.startsWith("@")
    ? `https://t.me/${FORCE_SUB_CHANNEL.slice(1)}`
    : `https://t.me/${FORCE_SUB_CHANNEL}`;

  await bot.sendMessage(chatId,
    `🔒 *Access Denied!*\n\nYou must join our channel to use this bot.\n\nClick the button below to join, then press *I Joined* ✅`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Join Channel", url: channelLink }],
          [{ text: "✅ I Joined", callback_data: "check_sub" }],
        ],
      },
    }
  );
}

async function checkAccess(bot: TelegramBot, chatId: number, userId: number): Promise<boolean> {
  if (isAdmin(userId)) return true;

  if (isBanned(userId)) {
    await bot.sendMessage(chatId, `🚫 *You have been banned from using this bot.*`, { parse_mode: "Markdown" });
    return false;
  }

  if (!hasAccess(userId)) {
    if (isAccessModeOn()) {
      await bot.sendMessage(chatId,
        `🔒 *Access Restricted*\n\nThis bot is currently in restricted mode.\nContact the owner to get access: *@SPIDYWS*`,
        { parse_mode: "Markdown" }
      );
      return false;
    }
  }

  const subOk = await isSubscribed(bot, userId);
  if (!subOk) {
    await sendJoinMessage(bot, chatId);
    return false;
  }

  return true;
}

function sortEntries(entries: GroupEntry[]): GroupEntry[] {
  return [...entries].sort((a, b) => {
    const parseNameParts = (name: string) => {
      const cleaned = name.replace(/\s+/g, "");
      const match = cleaned.match(/^([A-Za-z]+)(\d+)(.*)$/);
      if (match) {
        return { prefix: match[1].toUpperCase(), num: parseInt(match[2], 10), suffix: match[3] };
      }
      return { prefix: name.toUpperCase(), num: 0, suffix: "" };
    };
    const pa = parseNameParts(a.name);
    const pb = parseNameParts(b.name);
    if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
    return pa.num - pb.num;
  });
}

function formatPendingList(entries: GroupEntry[]): string {
  const sorted = sortEntries(entries);
  const lines = sorted.map((e) => `${e.name} ✅ ${e.count}`);
  const total = sorted.reduce((sum, e) => sum + e.count, 0);
  const calc = sorted.map((e) => String(e.count)).join(" + ");
  const listBody = lines.join("\n");
  const totalLine = `Total = ${calc} = ${total}`;
  return `\`\`\`\n${listBody}\n\n${totalLine}\`\`\``;
}

const HELP_TEXT = `╔══════════════════════╗
║ 🤖 LIST MAKER BOT ║
╚══════════════════════╝

👑 Owner: @SPIDYWS
⚡ Fast AI-powered WhatsApp group tool

━━━━━━━━━━━━━━━━━━━━━━
📌 FEATURES
━━━━━━━━━━━━━━━━━━━━━━

📊 1. Pending Members List
➤ Send WhatsApp group screenshots
➤ Supports 50–100 screenshots at once
➤ AI reads group name + pending count
➤ Get instant total list with sum

🔗 2. WhatsApp Link Corrector
➤ Paste your WhatsApp group links
➤ Set a base name (e.g. SPIDY100)
➤ Exclude specific group numbers
➤ Get a clean, numbered output list

━━━━━━━━━━━━━━━━━━━━━━
🔧 COMMANDS
━━━━━━━━━━━━━━━━━━━━━━

/start — 🏠 Open main menu
/done — ✅ Finish current task
/reset — 🔄 Cancel & back to menu
/help — ❓ Show this help message

━━━━━━━━━━━━━━━━━━━━━━
💡 TIP: You can send multiple screenshots
at once — the bot processes them all fast!

🔥 Made with ❤️ by @SPIDYWS`;

const mainKeyboard = {
  inline_keyboard: [
    [{ text: "📊 Pending Members List", callback_data: "start_screenshots" }],
    [{ text: "🔗 WhatsApp Link Corrector", callback_data: "start_wa" }],
  ],
};

async function notifyAdmin(bot: TelegramBot, user: TelegramBot.User, chatId: number) {
  const adminId = getAdminId();
  if (!adminId || user.id === adminId) return;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  const username = user.username ? `@${user.username}` : "N/A";
  const text =
    `👤 *New User Started Bot*\n\n` +
    `• *Name:* ${name}\n` +
    `• *Username:* ${username}\n` +
    `• *User ID:* \`${user.id}\`\n` +
    `• *Chat ID:* \`${chatId}\`\n` +
    `• *Access Mode:* ${isAccessModeOn() ? "ON" : "OFF"}\n` +
    `• *Has Access:* ${hasAccess(user.id) ? "✅ Yes" : "❌ No"}\n` +
    `• *Banned:* ${isBanned(user.id) ? "🚫 Yes" : "No"}`;
  await bot.sendMessage(adminId, text, { parse_mode: "Markdown" }).catch(() => null);
}

function buildProgressBar(done: number, total: number): string {
  const filled = Math.round((done / total) * 10);
  const bar = "█".repeat(filled) + "░".repeat(10 - filled);
  const pct = Math.round((done / total) * 100);
  return `${bar} ${pct}% (${done}/${total})`;
}

async function processScreenshotQueue(bot: TelegramBot, chatId: number, userId: number): Promise<void> {
  const state = getState(userId);
  if (state.mode !== "screenshots" || state.processing) return;
  if (state.queue.length === 0) return;

  state.processing = true;

  try {
    while (true) {
      const s = getState(userId);
      if (s.mode !== "screenshots" || s.queue.length === 0) break;

      const batch = [...s.queue];
      s.queue.length = 0;

      logger.info({ count: batch.length, userId }, "Processing screenshot batch");

      const total_batch = batch.length;

      const statusMsg = await bot.sendMessage(
        chatId,
        `🔍 Processing screenshots...\n\n${buildProgressBar(0, total_batch)}\n\nPlease wait...`,
        { parse_mode: "Markdown" }
      ).catch(() => null);

      const newEntries: GroupEntry[] = [];
      let failed = 0;
      let done = 0;

      for (const fileId of batch) {
        try {
          const link = await bot.getFileLink(fileId);
          const resp = await fetch(link);
          if (!resp.ok) throw new Error("Download failed");
          const buf = await resp.arrayBuffer();
          const b64 = Buffer.from(buf).toString("base64");
          let mime = resp.headers.get("content-type") ?? "image/jpeg";
          if (!mime.startsWith("image/")) mime = "image/jpeg";

          const entries = await extractGroupDataFromImage(b64, mime);
          done++;
          if (entries.length > 0) {
            const cur = getState(userId);
            if (cur.mode === "screenshots") {
              cur.entries.push(...entries);
            }
            newEntries.push(...entries);
          } else {
            failed++;
          }
        } catch (err) {
          logger.error({ err }, "Error processing screenshot");
          failed++;
          done++;
        }

        if (statusMsg && done < total_batch) {
          const progressText =
            `🔍 Processing screenshots...\n\n${buildProgressBar(done, total_batch)}\n\n` +
            (newEntries.length > 0
              ? `✅ Found so far: ${newEntries.map((e) => `*${e.name}* (${e.count})`).join(", ")}\n`
              : "") +
            `Please wait...`;
          await bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: statusMsg.message_id,
            parse_mode: "Markdown",
          }).catch(() => null);
        }
      }

      const cur = getState(userId);
      const total = cur.mode === "screenshots" ? cur.entries.length : 0;

      let text = `✅ *Batch Done!* ${buildProgressBar(total_batch, total_batch)}\n\n`;
      if (newEntries.length > 0) text += newEntries.map((e) => `📌 *${e.name}* — ${e.count} pending`).join("\n") + "\n";
      if (failed > 0) {
        text += `\n⚠️ ${failed} screenshot${failed > 1 ? "s" : ""} could not be read\n`;
      }
      text += `\n━━━━━━━━━━━━━━━━━━━━\n`;
      text += `📊 *Total collected:* ${total} group${total !== 1 ? "s" : ""}\n\n`;
      text += `📤 Send more screenshots to add more\n`;
      text += `✅ Type */done* to get the *final sorted list with total sum*`;

      if (statusMsg) {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
          parse_mode: "Markdown",
        }).catch(() => bot.sendMessage(chatId, text, { parse_mode: "Markdown" }));
      } else {
        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
      }

      const after = getState(userId);
      if (after.mode !== "screenshots" || after.queue.length === 0) break;
    }
  } finally {
    const final = getState(userId);
    if (final.mode === "screenshots") {
      final.processing = false;
    }
  }
}

function addToQueue(bot: TelegramBot, chatId: number, userId: number, fileIds: string[]) {
  const state = getState(userId);
  if (state.mode !== "screenshots") return;
  state.queue.push(...fileIds);
  if (!state.processing) processScreenshotQueue(bot, chatId, userId);
}

export function startBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error("TELEGRAM_BOT_TOKEN not set — bot will not start");
    return;
  }

  loadData();
  const bot = new TelegramBot(token, { polling: true });
  logger.info("Telegram bot started");

  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId || !msg.from) return;

    const text = msg.text?.trim();
    const photo = msg.photo;
    const mediaGroupId = msg.media_group_id;

    if (text === "/start") {
      await notifyAdmin(bot, msg.from, chatId);
      const ok = await checkAccess(bot, chatId, userId);
      if (!ok) return;
      setState(userId, { mode: "idle" });
      await bot.sendMessage(chatId,
        `👋 *Welcome!*\n\nI'm your assistant bot.\n\n*What can I do?*\n• 📊 Extract pending member counts from WhatsApp screenshots\n• 🔗 Fix and rename WhatsApp group links\n\nChoose an option below:`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
      );
      return;
    }

    if (text === "/help") {
      const ok = await checkAccess(bot, chatId, userId);
      if (!ok) return;
      await bot.sendMessage(chatId, HELP_TEXT, { parse_mode: "Markdown" });
      return;
    }

    if (text === "/reset") {
      const ok = await checkAccess(bot, chatId, userId);
      if (!ok) return;
      setState(userId, { mode: "idle" });
      await bot.sendMessage(chatId,
        `🔄 *Reset done!*\n\nChoose an option:`,
        { parse_mode: "Markdown", reply_markup: mainKeyboard }
      );
      return;
    }

    if (text) {
      if (isAdmin(userId)) {
        const parts = text.split(/\s+/);
        const cmd = parts[0]?.toLowerCase();

        if (cmd === "/admin") {
          await bot.sendMessage(chatId, ADMIN_HELP, { parse_mode: "Markdown" });
          return;
        }

        if (cmd === "/status") {
          await bot.sendMessage(chatId, getStatusText(), { parse_mode: "Markdown" });
          return;
        }

        if (cmd === "/access") {
          const sub = parts[1]?.toLowerCase();
          if (sub === "on") {
            setAccessMode(true);
            await bot.sendMessage(chatId, "✅ Access mode ON — only approved users can use the bot.");
          } else if (sub === "off") {
            setAccessMode(false);
            await bot.sendMessage(chatId, "✅ Access mode OFF — everyone can use the bot.");
          } else if (sub && parts[2]) {
            const targetId = parseInt(sub, 10);
            const days = parseInt(parts[2], 10);
            if (!isNaN(targetId) && !isNaN(days)) {
              grantAccess(targetId, days);
              await bot.sendMessage(chatId, `✅ Access granted to \`${targetId}\` for ${days === 0 ? "permanent" : `${days} days`}.`, { parse_mode: "Markdown" });
            } else {
              await bot.sendMessage(chatId, "⚠️ Usage: /access [user_id] [days]");
            }
          } else {
            await bot.sendMessage(chatId, "⚠️ Usage: /access on | off | [user_id] [days]");
          }
          return;
        }

        if (cmd === "/ban" && parts[1]) {
          const targetId = parseInt(parts[1], 10);
          if (!isNaN(targetId)) {
            banUser(targetId);
            await bot.sendMessage(chatId, `🚫 User \`${targetId}\` has been banned.`, { parse_mode: "Markdown" });
          }
          return;
        }

        if (cmd === "/unban" && parts[1]) {
          const targetId = parseInt(parts[1], 10);
          if (!isNaN(targetId)) {
            unbanUser(targetId);
            await bot.sendMessage(chatId, `✅ User \`${targetId}\` has been unbanned.`, { parse_mode: "Markdown" });
          }
          return;
        }

        if (cmd === "/revoke" && parts[1]) {
          const targetId = parseInt(parts[1], 10);
          if (!isNaN(targetId)) {
            revokeAccess(targetId);
            await bot.sendMessage(chatId, `✅ Access revoked for \`${targetId}\`.`, { parse_mode: "Markdown" });
          }
          return;
        }
      }
    }

    const ok = await checkAccess(bot, chatId, userId);
    if (!ok) return;

    if (text === "/done") {
      const s = getState(userId);
      if (s.mode !== "screenshots") {
        await bot.sendMessage(chatId, "ℹ️ You're not in screenshot mode. Start with the menu.");
        return;
      }
      if (s.queue.length > 0 || s.processing) {
        await bot.sendMessage(chatId, "⏳ Still processing... please wait and try /done again.");
        return;
      }
      if (s.entries.length === 0) {
        await bot.sendMessage(chatId, "⚠️ No data collected yet. Send some screenshots first.");
        return;
      }
      const list = formatPendingList(s.entries);
      setState(userId, { mode: "idle" });
      await bot.sendMessage(chatId, `📋 *Final Pending List:*\n\n${list}`, { parse_mode: "Markdown" });
      return;
    }

    if (photo) {
      const s = getState(userId);
      if (s.mode !== "screenshots") {
        await bot.sendMessage(chatId, "ℹ️ Send /start first and select *Pending Members List* to use screenshot mode.", { parse_mode: "Markdown" });
        return;
      }

      const fileId = photo[photo.length - 1]!.file_id;

      if (mediaGroupId) {
        const existing = mediaGroupBuffers.get(mediaGroupId);
        if (existing) {
          existing.fileIds.push(fileId);
          clearTimeout(existing.timer);
          existing.timer = setTimeout(() => {
            mediaGroupBuffers.delete(mediaGroupId);
            addToQueue(bot, existing.chatId, existing.userId, existing.fileIds);
          }, 1000);
        } else {
          const timer = setTimeout(() => {
            const buf = mediaGroupBuffers.get(mediaGroupId);
            if (buf) {
              mediaGroupBuffers.delete(mediaGroupId);
              addToQueue(bot, buf.chatId, buf.userId, buf.fileIds);
            }
          }, 1000);
          mediaGroupBuffers.set(mediaGroupId, { chatId, userId, fileIds: [fileId], timer });
        }
      } else {
        addToQueue(bot, chatId, userId, [fileId]);
      }
      return;
    }

    if (text) {
      const s = getState(userId);

      if (s.mode === "wa_links") {
        const links = extractLinks(text);
        if (links.length === 0) {
          await bot.sendMessage(chatId,
            "⚠️ No valid WhatsApp links found. Paste links like:\nhttps://chat.whatsapp.com/...",
            { parse_mode: "Markdown" }
          );
          return;
        }
        setState(userId, { mode: "wa_name", links });
        await bot.sendMessage(chatId,
          `✅ Got *${links.length}* link${links.length !== 1 ? "s" : ""}!\n\nNow send the *starting group name* (e.g. *SPIDY100* or *FH100*):`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (s.mode === "wa_name") {
        const parsed = parseBaseName(text);
        if (!parsed) {
          await bot.sendMessage(chatId,
            "⚠️ Invalid format. Send a name like *SPIDY100* or *FH100* (letters followed by a number)",
            { parse_mode: "Markdown" }
          );
          return;
        }
        setState(userId, { mode: "wa_exclusions", links: s.links, prefix: parsed.prefix, startNum: parsed.startNum });

        const preview = buildOutput(s.links, parsed.prefix, parsed.startNum, new Set());
        const previewText = preview.length > 3000 ? preview.slice(0, 3000) + "\n..." : preview;

        await bot.sendMessage(chatId,
          `✅ *Preview (all ${s.links.length} links):*\n\n${previewText}\n\nTo *exclude* any names, send them separated by commas:\ne.g. *${parsed.prefix}${parsed.startNum + 1}, ${parsed.prefix}${parsed.startNum + 3}*\n\nOr press Done to get the full list.`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "✅ Done — Get Full List", callback_data: "skip_exclusions" }],
                [{ text: "🔙 Back to Menu", callback_data: "menu" }],
              ],
            },
          }
        );
        return;
      }

      if (s.mode === "wa_exclusions") {
        const excludeSet = new Set<string>(
          text.split(/[\s,،]+/).map((x) => x.trim().toUpperCase()).filter(Boolean)
        );
        const output = buildOutput(s.links, s.prefix, s.startNum, excludeSet);
        if (!output) {
          await bot.sendMessage(chatId, "⚠️ No links remaining after exclusions!");
          return;
        }
        setState(userId, { mode: "idle" });
        await bot.sendMessage(chatId, `📋 *Final List:*\n\n${output}`, { parse_mode: "Markdown" });
        return;
      }

      if (s.mode === "screenshots") {
        await bot.sendMessage(chatId, `📸 Screenshots bhejte raho, ya */done* likho final list ke liye.`, { parse_mode: "Markdown" });
        return;
      }

      if (s.mode === "idle") {
        await bot.sendMessage(chatId, `🚀 *What do you want to do?*`, { parse_mode: "Markdown", reply_markup: mainKeyboard });
      }
    }
  });

  bot.on("callback_query", async (query) => {
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    const msgId = query.message?.message_id;

    if (!chatId || !msgId) {
      await bot.answerCallbackQuery(query.id).catch(() => null);
      return;
    }

    const ok = await checkAccess(bot, chatId, userId);
    if (!ok) {
      await bot.answerCallbackQuery(query.id, { text: "Access denied." }).catch(() => null);
      return;
    }

    try {
      const data = query.data;

      if (data === "check_sub") {
        const subOk = await isSubscribed(bot, userId);
        if (subOk) {
          await bot.answerCallbackQuery(query.id, { text: "✅ Verified! You can now use the bot." }).catch(() => null);
          await bot.editMessageText(
            `🚀 *What do you want to do?*`,
            { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: mainKeyboard }
          ).catch(() => null);
        } else {
          await bot.answerCallbackQuery(query.id, { text: "❌ You haven't joined yet!" }).catch(() => null);
        }
        return;
      }

      if (data === "start_screenshots") {
        await bot.answerCallbackQuery(query.id).catch(() => null);
        setState(userId, { mode: "screenshots", entries: [], queue: [], processing: false });
        await bot.editMessageText(
          `📸 *Screenshot Mode Active!*\n\nSend me WhatsApp screenshots showing group pending members.\n\n• You can send multiple screenshots at once\n• Type */done* when finished to get the sorted list`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu" }]] },
          }
        ).catch(() => null);
        return;
      }

      if (data === "start_wa") {
        await bot.answerCallbackQuery(query.id).catch(() => null);
        setState(userId, { mode: "wa_links", links: [] });
        await bot.editMessageText(
          `🔗 *WhatsApp Link Corrector*\n\nPaste your WhatsApp group links below (one per line or all together):`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Menu", callback_data: "menu" }]] },
          }
        ).catch(() => null);
        return;
      }

      if (data === "menu") {
        await bot.answerCallbackQuery(query.id).catch(() => null);
        setState(userId, { mode: "idle" });
        await bot.editMessageText(
          `🚀 *What do you want to do?*`,
          { chat_id: chatId, message_id: msgId, parse_mode: "Markdown", reply_markup: mainKeyboard }
        ).catch(() => null);
        return;
      }

      if (data === "skip_exclusions") {
        const s = getState(userId);
        if (s.mode === "screenshots" && (s.queue.length > 0 || s.processing)) {
          await bot.answerCallbackQuery(query.id, { text: "⏳ Still processing..." }).catch(() => null);
          return;
        }
        if (s.mode === "wa_exclusions") {
          await bot.answerCallbackQuery(query.id).catch(() => null);
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => null);
          const output = buildOutput(s.links, s.prefix, s.startNum, new Set());
          setState(userId, { mode: "idle" });
          await bot.sendMessage(chatId, `📋 *Final List:*\n\n${output}`, { parse_mode: "Markdown" });
        } else {
          await bot.answerCallbackQuery(query.id).catch(() => null);
        }
        return;
      }

      await bot.answerCallbackQuery(query.id).catch(() => null);
    } catch (err) {
      logger.error({ err }, "Callback query error");
      await bot.answerCallbackQuery(query.id, { text: "Error, please try again." }).catch(() => null);
    }
  });

  bot.on("polling_error", (err) => {
    logger.error({ err }, "Telegram polling error");
  });
}
