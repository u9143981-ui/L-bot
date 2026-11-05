/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Soenx Card Checker Bot
   Credit: @Soenx
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const fs = require("fs");
const express = require("express");
const { faker } = require("@faker-js/faker");
const config = require("./config.js");

// ===== EXPRESS =====
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send(`${config.brand} Card Checker Bot is running! 🚀`));
app.listen(port, () => console.log(`[⚡] Active on port ${port} | Credit: ${config.brand}`));

// ===== CONFIG =====
const { apiId, apiHash, botToken, sessionFile, adminFile, usersFile, gatewayBot, gatewayCmd, brand, timeoutSeconds } = config;

// ===== FILES =====
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "[]");
let savedSessions = JSON.parse(fs.readFileSync(sessionFile));

let adminList = [];
if (fs.existsSync(adminFile)) {
    adminList = JSON.parse(fs.readFileSync(adminFile));
} else {
    adminList = config.adminId.split(",").map(s => s.trim());
    fs.writeFileSync(adminFile, JSON.stringify(adminList));
}

let knownUsers = [];
if (fs.existsSync(usersFile)) knownUsers = JSON.parse(fs.readFileSync(usersFile));
function addUser(id) {
    if (!knownUsers.includes(id)) {
        knownUsers.push(id);
        fs.writeFileSync(usersFile, JSON.stringify(knownUsers));
    }
}

let clients = [];
let pendingLogins = {};
let lastLoginTime = 0;
const LOGIN_COOLDOWN = 10 * 1000;

// ===== CARD VALIDATION =====
function validateAndParseCard(text) {
    text = text.trim().replace(/\s/g, "");
    if (text.includes("|") || text.includes(":")) {
        const sep = text.includes("|") ? "|" : ":";
        const parts = text.split(sep);
        if (parts.length >= 4) {
            let num = parts[0].trim(), mm = parts[1].trim().padStart(2, "0"), yy = parts[2].trim(), cvv = parts[3].trim();
            if (yy.length === 4) yy = yy.slice(-2);
            yy = yy.padStart(2, "0");
            if (parseInt(mm) >= 1 && parseInt(mm) <= 12 && /^\d{15,16}$/.test(num) && /^\d{2}$/.test(mm) && /^\d{2}$/.test(yy) && /^\d{3,4}$/.test(cvv)) {
                return { valid: true, card: `${num}|${mm}|${yy}|${cvv}` };
            }
        }
    }
    let m = text.match(/^(\d{15,16})(\d{2})(\d{2,4})(\d{3,4})$/);
    if (m) {
        let num = m[1], mm = m[2].padStart(2, "0"), yy = m[3], cvv = m[4];
        if (yy.length === 4) yy = yy.slice(-2);
        yy = yy.padStart(2, "0");
        if (parseInt(mm) >= 1 && parseInt(mm) <= 12) return { valid: true, card: `${num}|${mm}|${yy}|${cvv}` };
    }
    m = text.match(/(\d{15,16})\D*(\d{2})\D*(\d{2,4})\D*(\d{3,4})/);
    if (m) {
        let num = m[1], mm = m[2].padStart(2, "0"), yy = m[3], cvv = m[4];
        if (yy.length === 4) yy = yy.slice(-2);
        yy = yy.padStart(2, "0");
        if (parseInt(mm) >= 1 && parseInt(mm) <= 12) return { valid: true, card: `${num}|${mm}|${yy}|${cvv}` };
    }
    return { valid: false, card: null };
}

// ===== GATEWAY PARSER =====
function _clean(s) {
    return (s || "").replace(/[^\x00-\x7F]+/g, "").trim();
}
function parseBotReply(text) {
    const grab = (field) => {
        const m = text.match(new RegExp(`${field}:\\s*(.*?)(?:\\n|$)`, "i"));
        return m ? m[1].trim() : "";
    };
    const bankRaw = grab("Bank");
    let bank = bankRaw, type = "";
    if (bankRaw.includes(" - ")) {
        const p = bankRaw.split(" - ");
        bank = p[0].trim();
        type = p[1].trim();
    }
    const countryRaw = grab("Country");
    const flagMatch = countryRaw.match(/([\u{1F1E6}-\u{1F1FF}]{2})/u);
    return {
        cc: grab("CC"),
        status: _clean(grab("Status")),
        response: _clean(grab("Message") || grab("Response")),
        gateway: _clean(grab("Gateway")),
        bank: _clean(bank),
        type: _clean(type).toLowerCase(),
        country: _clean(countryRaw).replace(/[^\x00-\x7F]/g, "").trim(" -"),
        flag: flagMatch ? flagMatch[1] : "",
        time_taken: _clean(grab("Time Taken")),
        used_by: _clean(grab("Used By"))
    };
}
function isFinalResponse(text) {
    const status = (text.match(/Status:\s*(.*?)(?:\n|$)/) || [, ""])[1].toLowerCase();
    const msg = ((text.match(/Message:\s*(.*?)(?:\n|$)/) || text.match(/Response:\s*(.*?)(?:\n|$)/) || [])[1] || "").toLowerCase();
    if (["process", "checking", "pending", "wait", "⏳"].some(k => status.includes(k))) return false;
    if (["process", "checking", "pending", "wait", "⏳"].some(k => msg.includes(k))) return false;
    return !!(status && msg);
}

// ===== GATEWAY SEND =====
async function sendCardToGateway(cardData) {
    const client = clients[0];
    if (!client) return { error: "No active session. Admin ko /login karna hoga." };
    try {
        const entity = await client.getEntity(gatewayBot);
        await client.sendMessage(entity, { message: `${gatewayCmd} ${cardData}` });
        let lastText = "", processingSeen = false;
        const start = Date.now();
        while (Date.now() - start < timeoutSeconds * 1000) {
            await new Promise(r => setTimeout(r, 2000));
            const msgs = await client.getMessages(entity, { limit: 1 });
            if (msgs.length) {
                const txt = msgs[0].message || "";
                if (txt !== lastText) {
                    lastText = txt;
                    if (isFinalResponse(txt)) return parseBotReply(txt);
                    processingSeen = true;
                }
            }
        }
        if (processingSeen) {
            await new Promise(r => setTimeout(r, 5000));
            const msgs = await client.getMessages(entity, { limit: 1 });
            if (msgs.length && isFinalResponse(msgs[0].message)) return parseBotReply(msgs[0].message);
        }
        return { error: "No valid reply from gateway after timeout." };
    } catch (e) {
        return { error: e.message };
    }
}

// ===== BIN INFO =====
async function getBinInfo(bin) {
    try {
        const res = await fetch(`https://lookup.binlist.net/${bin}`, {
            headers: { "Accept-Version": "3" }
        });
        if (!res.ok) return { error: "BIN not found" };
        const d = await res.json();
        return {
            bin,
            bank: d.bank?.name || "Unknown",
            brand: (d.scheme || "Unknown").toUpperCase(),
            category: d.prepaid ? "Prepaid" : "Standard",
            type: (d.type || "Unknown").charAt(0).toUpperCase() + (d.type || "").slice(1),
            country: d.country?.name || "Unknown"
        };
    } catch (e) {
        return { error: e.message };
    }
}

// ===== FAKE ADDRESS =====
function generateFakeAddress(country) {
    const c = (country || "US").toUpperCase();
    try {
        let addr;
        if (["US", "USA", "UNITED STATES"].includes(c)) {
            addr = {
                "Street 1": faker.location.streetAddress(),
                "Street 2": faker.location.secondaryAddress(),
                "City": faker.location.city(),
                "State": faker.location.state(),
                "ZIP": faker.location.zipCode(),
                "Country": "United States",
                "Phone": faker.phone.number()
            };
        } else if (["UK", "GB", "UNITED KINGDOM"].includes(c)) {
            addr = {
                "Street 1": faker.location.streetAddress(),
                "Street 2": faker.location.secondaryAddress(),
                "City": faker.location.city(),
                "Postcode": faker.location.zipCode(),
                "Country": "United Kingdom",
                "Phone": faker.phone.number()
            };
        } else if (["IN", "INDIA"].includes(c)) {
            addr = {
                "Street 1": faker.location.streetAddress(),
                "Street 2": faker.location.secondaryAddress(),
                "City": faker.location.city(),
                "State": faker.location.state(),
                "PIN": faker.location.zipCode(),
                "Country": "India",
                "Phone": faker.phone.number()
            };
        } else if (["CA", "CANADA"].includes(c)) {
            addr = {
                "Street 1": faker.location.streetAddress(),
                "Street 2": faker.location.secondaryAddress(),
                "City": faker.location.city(),
                "Province": faker.location.state(),
                "Postal Code": faker.location.zipCode(),
                "Country": "Canada",
                "Phone": faker.phone.number()
            };
        } else {
            addr = {
                "Street 1": faker.location.streetAddress(),
                "Street 2": faker.location.secondaryAddress(),
                "City": faker.location.city(),
                "Country": c,
                "Postal Code": faker.location.zipCode(),
                "Phone": faker.phone.number()
            };
        }
        return addr;
    } catch (e) {
        return { error: e.message };
    }
}

// ===== BOT =====
async function init() {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`🚀 Soenx Card Checker Bot starting...`);
    console.log(`🛡 Credit: ${brand}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    for (const s of savedSessions) {
        try {
            const c = new TelegramClient(new StringSession(s), apiId, apiHash, { connectionRetries: 5 });
            await c.connect();
            clients.push(c);
            console.log("✅ Session loaded");
        } catch (e) { console.log("⚠️ Session load failed:", e.message); }
    }

    const botClient = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 5 });
    await botClient.start({ botAuthToken: botToken });
    console.log(`🤖 Bot online | Credit: ${brand}`);

    botClient.addEventHandler(async (event) => {
        const message = event.message;
        if (!message || !message.text) return;
        const senderId = message.senderId ? message.senderId.toString() : "unknown";
        const isAdmin = adminList.includes(senderId);
        addUser(senderId);

        const args = message.text.split(" ");
        const cmd = args[0].toLowerCase();

        // ===== /start =====
        if (cmd === "/start") {
            if (isAdmin) {
                await message.reply({
                    message:
                        `👋 Welcome Boss!\n\n` +
                        `🛠 **Admin Commands:**\n` +
                        `🔹 \`/login +91xxxx\`\n` +
                        `🔹 \`/otp 12 345\`\n` +
                        `🔹 \`/pass password\`\n` +
                        `🔹 \`/addadmin ID\`\n` +
                        `🔹 \`/stats\`\n` +
                        `🔹 \`/sescount\`\n\n` +
                        `🌐 **User Commands:**\n` +
                        `🔹 \`/au cc|mm|yy|cvv\` - Check Card\n` +
                        `🔹 \`/bin 411111\` - BIN Info\n` +
                        `🔹 \`/fake US\` - Fake Address\n\n` +
                        `🛡 Credit: ${brand}`
                });
            } else {
                await message.reply({
                    message:
                        `👋 Welcome to ${brand} Card Checker Bot!\n\n` +
                        `📋 **Commands:**\n` +
                        `🔹 \`/au cc|mm|yy|cvv\` - Check Card\n` +
                        `🔹 \`/bin 411111\` - BIN Info\n` +
                        `🔹 \`/fake US\` - Fake Address\n\n` +
                        `🛡 Credit: ${brand}`
                });
            }
        }

        // ===== /au =====
        else if (cmd === "/au") {
            const cardText = args.slice(1).join(" ");
            if (!cardText) return message.reply({ message: "⚠️ Usage: `/au cc|mm|yy|cvv`" });
            const parsed = validateAndParseCard(cardText);
            if (!parsed.valid) return message.reply({ message: "❌ Invalid card format." });
            if (!clients.length) return message.reply({ message: "❌ No active session. Admin se contact karo." });

            const statusMsg = await message.reply({ message: "🔄 Processing..." });
            const result = await sendCardToGateway(parsed.card);

            if (result.error) {
                return botClient.editMessage(message.chatId, {
                    message: statusMsg.id,
                    text: `❌ Error: ${result.error}`
                });
            }

            const formatted =
                `<b>CC:</b> <code>${result.cc || parsed.card}</code>\n` +
                `<b>Status:</b> ${result.status}\n` +
                `<b>Response:</b> ${result.response}\n` +
                `<b>Gateway:</b> ${result.gateway}\n` +
                `<b>Bank:</b> ${result.bank}\n` +
                `<b>Type:</b> ${result.type}\n` +
                `<b>Country:</b> ${result.country} ${result.flag}\n` +
                `<b>Time Taken:</b> ${result.time_taken || "N/A"}\n` +
                `<b>Checked by:</b> <a href="tg://user?id=${senderId}">${senderId}</a>`;

            await botClient.editMessage(message.chatId, {
                message: statusMsg.id,
                text: formatted,
                parseMode: "html"
            });
        }

        // ===== /bin =====
        else if (cmd === "/bin") {
            const binText = args[1];
            if (!binText) return message.reply({ message: "⚠️ Usage: `/bin 411111`" });
            const m = binText.match(/(\d{6})/);
            if (!m) return message.reply({ message: "❌ Invalid BIN. 6 digits do." });

            const msg = await message.reply({ message: "🔄 Fetching BIN info..." });
            const info = await getBinInfo(m[1]);

            if (info.error) {
                return botClient.editMessage(message.chatId, {
                    message: msg.id,
                    text: `❌ Error: ${info.error}`
                });
            }

            await botClient.editMessage(message.chatId, {
                message: msg.id,
                text:
                    `<b>BIN:</b> <code>${info.bin}</code>\n` +
                    `<b>Bank:</b> ${info.bank}\n` +
                    `<b>Brand:</b> ${info.brand}\n` +
                    `<b>Category:</b> ${info.category}\n` +
                    `<b>Type:</b> ${info.type}\n` +
                    `<b>Country:</b> ${info.country}`,
                parseMode: "html"
            });
        }

        // ===== /fake =====
        else if (cmd === "/fake") {
            const country = args[1] || "US";
            const addr = generateFakeAddress(country);
            if (addr.error) return message.reply({ message: `❌ Error: ${addr.error}` });

            let text = "";
            for (const [k, v] of Object.entries(addr)) {
                text += `<b>${k}:</b> <code>${v}</code>\n`;
            }
            await message.reply({ message: text });
        }

        // ===== ADMIN ONLY =====
        else if (["/login", "/otp", "/pass", "/addadmin", "/stats", "/sescount"].includes(cmd)) {
            if (!isAdmin) return message.reply({ message: "⛔ Ye command sirf admin ke liye hai." });

            if (cmd === "/login") {
                const phone = args[1];
                if (!phone) return message.reply({ message: "⚠️ Usage: `/login +91xxxxxxx`" });
                const now = Date.now();
                if (now - lastLoginTime < LOGIN_COOLDOWN) {
                    const left = Math.ceil((LOGIN_COOLDOWN - (now - lastLoginTime)) / 1000);
                    return message.reply({ message: `⏳ Wait ${left}s.` });
                }
                if (pendingLogins[senderId]) return message.reply({ message: "⚠️ Login in progress." });

                await message.reply({ message: "📡 Connecting..." });
                const temp = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 1 });
                pendingLogins[senderId] = { client: temp, phone };

                temp.start({
                    phoneNumber: phone,
                    phoneCode: async () => {
                        await message.reply({ message: `📩 OTP sent to ${phone}.\nReply: \`/otp 12 345\`` });
                        pendingLogins[senderId].otpPromise = new Promise(res => pendingLogins[senderId].resolveOtp = res);
                        return await pendingLogins[senderId].otpPromise;
                    },
                    password: async () => {
                        await message.reply({ message: "🔐 2FA required. Reply: `/pass your_password`" });
                        pendingLogins[senderId].passPromise = new Promise(res => pendingLogins[senderId].resolvePass = res);
                        return await pendingLogins[senderId].passPromise;
                    }
                }).then(async () => {
                    const sessionStr = temp.session.save();
                    savedSessions.push(sessionStr);
                    fs.writeFileSync(sessionFile, JSON.stringify(savedSessions));
                    clients.push(temp);
                    lastLoginTime = Date.now();
                    delete pendingLogins[senderId];
                    await message.reply({ message: `✅ Account linked! Credit: ${brand}` });
                }).catch(async (err) => {
                    await message.reply({ message: "❌ Login failed: " + err.message });
                    delete pendingLogins[senderId];
                });
            }

            else if (cmd === "/otp") {
                const otp = args.slice(1).join("").replace(/[^0-9]/g, "");
                const data = pendingLogins[senderId];
                if (!data || !data.resolveOtp) return message.reply({ message: "❌ Use /login first." });
                data.resolveOtp(otp);
            }

            else if (cmd === "/pass") {
                const pass = args.slice(1).join(" ");
                if (pendingLogins[senderId]?.resolvePass) {
                    await message.reply({ message: "⏳ Verifying..." });
                    pendingLogins[senderId].resolvePass(pass);
                }
            }

            else if (cmd === "/addadmin") {
                const newAdmin = args[1];
                if (!newAdmin) return message.reply({ message: "⚠️ Usage: `/addadmin ID`" });
                if (adminList.includes(newAdmin)) return message.reply({ message: "⚠️ Already admin." });
                adminList.push(newAdmin);
                fs.writeFileSync(adminFile, JSON.stringify(adminList));
                await message.reply({ message: `✅ New admin: \`${newAdmin}\`` });
            }

            else if (cmd === "/stats") {
                await message.reply({
                    message:
                        `📊 **Stats**\n\n` +
                        `✅ Active Accounts: ${clients.length}\n` +
                        `👑 Admins: ${adminList.length}\n` +
                        `👥 Users: ${knownUsers.length}\n` +
                        `🛡 Credit: ${brand}`
                });
            }

            else if (cmd === "/sescount") {
                await message.reply({ message: `📁 Active Sessions: ${clients.length}` });
            }
        }

        else {
            await message.reply({ message: `❓ Unknown command. Use /start.` });
        }
    }, new NewMessage({ incoming: true }));
}

init().catch(console.error);
