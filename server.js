import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ============================================================
// CONFIG
// ============================================================

const MODEL = "gemini-3.8-flash";

const DATA_DIR = path.resolve("./data");
const PROJECTS_DIR = path.resolve("./projects");
const CHATS_DIR = path.resolve("./chats");
const KEY_STORE_PATH = path.join(DATA_DIR, "api-keys.json");

await fs.mkdir(DATA_DIR, { recursive: true });
await fs.mkdir(PROJECTS_DIR, { recursive: true });
await fs.mkdir(CHATS_DIR, { recursive: true });

// ============================================================
// KEY STORE
// ============================================================

let keyStore = null;
let keyWriteQueue = Promise.resolve();

const aiClients = new Map();

function maskKey(key) {
    const s = String(key || "");

    if (!s) return "••••••••";

    if (s.length <= 10) {
        return "••••••••";
    }

    return `${s.slice(0, 4)}••••••••${s.slice(-4)}`;
}

function cleanName(name) {
    const value = String(name || "").trim();

    if (!value) {
        return "Gemini Key";
    }

    return value.slice(0, 60);
}

function publicKey(record) {
    return {
        id: record.id,
        name: record.name,
        provider: "Google Gemini",
        primary: !!record.primary,
        enabled: record.enabled !== false,
        active: keyStore?.activeKeyId === record.id,
        maskedKey: maskKey(record.apiKey),
        status: record.status || "ready",
        lastError: record.lastError || null,
        lastErrorAt: record.lastErrorAt || null,
        createdAt: record.createdAt || null,
        lastUsedAt: record.lastUsedAt || null
    };
}

async function saveKeyStore() {
    const output = JSON.stringify(keyStore, null, 2);

    keyWriteQueue = keyWriteQueue
        .catch(() => {})
        .then(() =>
            fs.writeFile(
                KEY_STORE_PATH,
                output,
                "utf8"
            )
        );

    return keyWriteQueue;
}

async function loadKeyStore() {
    if (keyStore) {
        return keyStore;
    }

    let stored = null;

    try {
        const raw = await fs.readFile(
            KEY_STORE_PATH,
            "utf8"
        );

        stored = JSON.parse(raw);
    } catch {
        stored = null;
    }

    if (
        !stored ||
        !Array.isArray(stored.keys)
    ) {
        stored = {
            activeKeyId: "primary",
            keys: []
        };
    }

    const renderKey =
        String(process.env.GEMINI_API_KEY || "").trim();

    let primary =
        stored.keys.find(
            key => key.id === "primary"
        );

    if (renderKey) {
        if (!primary) {
            primary = {
                id: "primary",
                name: "Render Primary",
                provider: "Google Gemini",
                apiKey: renderKey,
                primary: true,
                enabled: true,
                status: "ready",
                lastError: null,
                lastErrorAt: null,
                createdAt: Date.now(),
                lastUsedAt: null
            };

            stored.keys.unshift(primary);
        } else {
            // تحديث مفتاح Render إذا تغيّر
            if (primary.apiKey !== renderKey) {
                primary.apiKey = renderKey;
                primary.status = "ready";
                primary.lastError = null;
                primary.lastErrorAt = null;

                aiClients.delete("primary");
            }

            primary.name = "Render Primary";
            primary.provider = "Google Gemini";
            primary.primary = true;
            primary.enabled = true;
        }
    }

    if (
        !stored.keys.some(
            key =>
                key.id === stored.activeKeyId &&
                key.enabled !== false
        )
    ) {
        if (
            stored.keys.some(
                key =>
                    key.id === "primary" &&
                    key.enabled !== false
            )
        ) {
            stored.activeKeyId = "primary";
        } else {
            const first = stored.keys.find(
                key => key.enabled !== false
            );

            stored.activeKeyId =
                first?.id || null;
        }
    }

    keyStore = stored;

    await saveKeyStore();

    return keyStore;
}

function getActiveKeyRecord() {
    if (!keyStore) {
        return null;
    }

    let active =
        keyStore.keys.find(
            key =>
                key.id === keyStore.activeKeyId &&
                key.enabled !== false
        );

    if (active) {
        return active;
    }

    active =
        keyStore.keys.find(
            key =>
                key.id === "primary" &&
                key.enabled !== false
        );

    if (active) {
        keyStore.activeKeyId = active.id;
    }

    return active || null;
}

function getAIForKey(record) {
    if (!record?.apiKey) {
        throw new Error(
            "Gemini API key is required."
        );
    }

    if (!aiClients.has(record.id)) {
        aiClients.set(
            record.id,
            new GoogleGenAI({
                apiKey: record.apiKey
            })
        );
    }

    return aiClients.get(record.id);
}

// ============================================================
// KEY ROUTES
// ============================================================

app.get("/keys", async (req, res) => {
    try {
        await loadKeyStore();

        const active =
            getActiveKeyRecord();

        return res.json({
            ok: true,

            activeKeyId:
                keyStore.activeKeyId,

            activeKeyName:
                active?.name || null,

            savedKeys:
                keyStore.keys.length,

            primary:
                keyStore.keys.find(
                    key => key.id === "primary"
                )
                    ? publicKey(
                        keyStore.keys.find(
                            key =>
                                key.id === "primary"
                        )
                    )
                    : null,

            keys:
                keyStore.keys
                    .filter(
                        key =>
                            key.id !== "primary"
                    )
                    .map(publicKey)
        });

    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


app.post("/keys", async (req, res) => {
    try {
        await loadKeyStore();

        const name =
            cleanName(req.body?.name);

        // يقبل الاثنين
        const apiKey =
            String(
                req.body?.apiKey ||
                req.body?.key ||
                ""
            ).trim();

        if (!apiKey) {
            return res.status(400).json({
                ok: false,
                error:
                    "Gemini API key is required."
            });
        }

        if (apiKey.length < 20) {
            return res.status(400).json({
                ok: false,
                error:
                    "Gemini API key looks invalid."
            });
        }

        const id =
            "key_" +
            Date.now() +
            "_" +
            crypto
                .randomBytes(4)
                .toString("hex");

        const record = {
            id,
            name,
            provider: "Google Gemini",
            apiKey,
            primary: false,
            enabled: true,
            status: "ready",
            lastError: null,
            lastErrorAt: null,
            createdAt: Date.now(),
            lastUsedAt: null
        };

        keyStore.keys.push(record);

        // المفتاح الجديد يصير Active مباشرة
        keyStore.activeKeyId = id;

        await saveKeyStore();

        return res.json({
            ok: true,
            activeKeyId: id,
            activeKeyName: name,
            key: publicKey(record)
        });

    } catch (err) {
        console.error(
            "ADD KEY ERROR:",
            err.message
        );

        return res.status(500).json({
            ok: false,
            error:
                err.message ||
                "Failed to save API key."
        });
    }
});


app.post("/keys/use", async (req, res) => {
    try {
        await loadKeyStore();

        const id =
            String(
                req.body?.id || ""
            ).trim();

        const record =
            keyStore.keys.find(
                key => key.id === id
            );

        if (!record) {
            return res.status(404).json({
                ok: false,
                error:
                    "API key not found."
            });
        }

        record.enabled = true;
        record.status = "ready";
        keyStore.activeKeyId = id;

        await saveKeyStore();

        return res.json({
            ok: true,
            activeKeyId: id,
            activeKeyName: record.name
        });

    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


app.post("/keys/enable", async (req, res) => {
    try {
        await loadKeyStore();

        const id =
            String(
                req.body?.id || ""
            ).trim();

        const record =
            keyStore.keys.find(
                key => key.id === id
            );

        if (!record) {
            return res.status(404).json({
                ok: false,
                error:
                    "API key not found."
            });
        }

        record.enabled = true;
        record.status = "ready";
        record.lastError = null;
        record.lastErrorAt = null;

        keyStore.activeKeyId = id;

        await saveKeyStore();

        return res.json({
            ok: true,
            activeKeyId: id,
            activeKeyName: record.name
        });

    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


app.post("/keys/stop", async (req, res) => {
    try {
        await loadKeyStore();

        const id =
            String(
                req.body?.id || ""
            ).trim();

        const record =
            keyStore.keys.find(
                key => key.id === id
            );

        if (!record) {
            return res.status(404).json({
                ok: false,
                error:
                    "API key not found."
            });
        }

        if (record.primary) {
            return res.status(400).json({
                ok: false,
                error:
                    "The primary Render key cannot be stopped."
            });
        }

        record.enabled = false;
        record.status = "stopped";

        if (keyStore.activeKeyId === id) {
            const primary =
                keyStore.keys.find(
                    key =>
                        key.id === "primary" &&
                        key.enabled !== false
                );

            keyStore.activeKeyId =
                primary?.id || null;
        }

        await saveKeyStore();

        return res.json({
            ok: true,
            activeKeyId:
                keyStore.activeKeyId
        });

    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


app.delete("/keys/:id", async (req, res) => {
    try {
        await loadKeyStore();

        const id =
            String(
                req.params.id || ""
            ).trim();

        const record =
            keyStore.keys.find(
                key => key.id === id
            );

        if (!record) {
            return res.status(404).json({
                ok: false,
                error:
                    "API key not found."
            });
        }

        if (record.primary) {
            return res.status(400).json({
                ok: false,
                error:
                    "The primary Render key cannot be deleted."
            });
        }

        keyStore.keys =
            keyStore.keys.filter(
                key => key.id !== id
            );

        aiClients.delete(id);

        if (keyStore.activeKeyId === id) {
            const primary =
                keyStore.keys.find(
                    key =>
                        key.id === "primary" &&
                        key.enabled !== false
                );

            keyStore.activeKeyId =
                primary?.id || null;
        }

        await saveKeyStore();

        return res.json({
            ok: true,
            activeKeyId:
                keyStore.activeKeyId
        });

    } catch (err) {
        return res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});

// ============================================================
// GEMINI
// ============================================================

function getErrorStatus(err) {
    return (
        err?.status ||
        err?.statusCode ||
        err?.response?.status ||
        null
    );
}

function isQuotaError(err) {
    const status =
        getErrorStatus(err);

    const message =
        String(
            err?.message || err || ""
        );

    return (
        status === 429 ||
        /429|quota|rate.?limit|resource.?exhausted/i
            .test(message)
    );
}

function isTemporaryError(err) {
    const status =
        getErrorStatus(err);

    const message =
        String(
            err?.message || err || ""
        );

    return (
        status === 503 ||
        status === 500 ||
        /503|service unavailable|temporarily unavailable/i
            .test(message)
    );
}

async function askGemini(prompt, job) {
    await loadKeyStore();

    const active =
        getActiveKeyRecord();

    if (!active) {
        throw new Error(
            "No Gemini API key is available. Add a Gemini API key from Keys."
        );
    }

    active.lastUsedAt = Date.now();

    const ai =
        getAIForKey(active);

    try {
        const response =
            await ai.models.generateContent({
                model: MODEL,

                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                text: prompt
                            }
                        ]
                    }
                ],

                config: {
                    thinkingConfig: {
                        thinkingLevel: "low"
                    },

                    maxOutputTokens: 12000
                }
            });

        active.status = "ready";
        active.lastError = null;
        active.lastErrorAt = null;

        await saveKeyStore();

        return (
            response?.text ||
            "Gemini returned an empty response."
        );

    } catch (err) {

        const raw =
            String(
                err?.message ||
                err ||
                "Gemini request failed."
            );

        if (isQuotaError(err)) {

            active.status = "quota";
            active.lastError =
                raw.slice(0, 500);
            active.lastErrorAt =
                Date.now();

            await saveKeyStore();

            const quotaError =
                new Error(
                    `المفتاح "${active.name}" وصل حد الاستخدام أو الـ Quota. اختر مفتاح Gemini آخر من Keys.`
                );

            quotaError.quota = true;
            quotaError.keyName =
                active.name;

            throw quotaError;
        }

        if (isTemporaryError(err)) {

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        2500
                    )
            );

            try {
                const retry =
                    await ai.models.generateContent({
                        model: MODEL,

                        contents: [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],

                        config: {
                            thinkingConfig: {
                                thinkingLevel: "low"
                            },

                            maxOutputTokens: 12000
                        }
                    });

                active.status = "ready";
                active.lastError = null;
                active.lastErrorAt = null;

                await saveKeyStore();

                return (
                    retry?.text ||
                    "Gemini returned an empty response."
                );

            } catch (retryErr) {

                const e =
                    new Error(
                        String(
                            retryErr?.message ||
                            retryErr ||
                            "Gemini temporarily unavailable."
                        )
                    );

                e.keyName =
                    active.name;

                throw e;
            }
        }

        active.status = "error";
        active.lastError =
            raw.slice(0, 500);
        active.lastErrorAt =
            Date.now();

        await saveKeyStore();

        const e =
            new Error(raw);

        e.keyName =
            active.name;

        throw e;
    }
}

// ============================================================
// PROJECT PATH SECURITY
// ============================================================

function safeProjectName(name) {
    const value =
        String(name || "project")
            .trim()
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(0, 80);

    return value || "project";
}

function safeRelativePath(filePath) {
    const value =
        String(filePath || "")
            .replace(/\\/g, "/")
            .replace(/^\/+/, "");

    if (
        !value ||
        value.includes("..") ||
        value.includes("\0") ||
        value.startsWith("etc/") ||
        value.startsWith("root/")
    ) {
        throw new Error(
            "Unsafe file path."
        );
    }

    return value;
}

function projectRoot(project) {
    return path.join(
        PROJECTS_DIR,
        safeProjectName(project)
    );
}

// ============================================================
// FILE TOOLS
// ============================================================

async function writeProjectFile(
    project,
    filePath,
    content
) {
    const root =
        projectRoot(project);

    const relative =
        safeRelativePath(filePath);

    const target =
        path.resolve(
            root,
            relative
        );

    if (
        target !== root &&
        !target.startsWith(
            root + path.sep
        )
    ) {
        throw new Error(
            "Unsafe file path."
        );
    }

    await fs.mkdir(
        path.dirname(target),
        {
            recursive: true
        }
    );

    await fs.writeFile(
        target,
        String(content ?? ""),
        "utf8"
    );

    return {
        ok: true,
        path: relative
    };
}

async function readProjectFile(
    project,
    filePath
) {
    const root =
        projectRoot(project);

    const relative =
        safeRelativePath(filePath);

    const target =
        path.resolve(
            root,
            relative
        );

    if (
        !target.startsWith(
            root + path.sep
        )
    ) {
        throw new Error(
            "Unsafe file path."
        );
    }

    const content =
        await fs.readFile(
            target,
            "utf8"
        );

    return {
        ok: true,
        path: relative,
        content
    };
}

async function deleteProjectFile(
    project,
    filePath
) {
    const root =
        projectRoot(project);

    const relative =
        safeRelativePath(filePath);

    const target =
        path.resolve(
            root,
            relative
        );

    if (
        !target.startsWith(
            root + path.sep
        )
    ) {
        throw new Error(
            "Unsafe file path."
        );
    }

    await fs.rm(
        target,
        {
            recursive: true,
            force: true
        }
    );

    return {
        ok: true,
        path: relative
    };
}

async function listDirectory(
    directory,
    base = directory
) {
    const entries =
        await fs.readdir(
            directory,
            {
                withFileTypes: true
            }
        );

    const result = [];

    for (const entry of entries) {
        const full =
            path.join(
                directory,
                entry.name
            );

        const relative =
            path.relative(
                base,
                full
            ).replace(/\\/g, "/");

        if (entry.isDirectory()) {
            result.push({
                type: "folder",
                path: relative
            });

            result.push(
                ...(await listDirectory(
                    full,
                    base
                ))
            );
        } else {
            result.push({
                type: "file",
                path: relative
            });
        }
    }

    return result;
}

// ============================================================
// TERMINAL
// ============================================================

const allowedCommands = new Set([
    "node",
    "npm",
    "npx",
    "python",
    "python3"
]);

const blockedPatterns = [
    "rm -rf",
    "shutdown",
    "reboot",
    "/etc/",
    "/root/",
    "../",
    "..\\",
    "mkfs",
    "dd if=",
    "chmod 777"
];

async function runTerminal(
    project,
    command,
    args = []
) {
    const cmd =
        String(command || "")
            .trim();

    if (!allowedCommands.has(cmd)) {
        throw new Error(
            `Command not allowed: ${cmd}`
        );
    }

    const joined =
        [
            cmd,
            ...args.map(String)
        ].join(" ");

    for (
        const blocked
        of blockedPatterns
    ) {
        if (
            joined
                .toLowerCase()
                .includes(
                    blocked.toLowerCase()
                )
        ) {
            throw new Error(
                "Blocked terminal command."
            );
        }
    }

    const cwd =
        projectRoot(project);

    await fs.mkdir(
        cwd,
        {
            recursive: true
        }
    );

    const result =
        await execFileAsync(
            cmd,
            args.map(String),
            {
                cwd,
                timeout: 120000,
                maxBuffer:
                    5 * 1024 * 1024
            }
        );

    return {
        ok: true,
        stdout:
            result.stdout || "",
        stderr:
            result.stderr || ""
    };
}

// ============================================================
// CHAT MEMORY
// ============================================================

function chatFile(id) {
    const safe =
        String(id || "default")
            .replace(
                /[^a-zA-Z0-9_-]/g,
                "-"
            )
            .slice(0, 80);

    return path.join(
        CHATS_DIR,
        `${safe || "default"}.json`
    );
}

async function loadChat(id) {
    try {
        const raw =
            await fs.readFile(
                chatFile(id),
                "utf8"
            );

        return JSON.parse(raw);
    } catch {
        return {
            id,
            messages: []
        };
    }
}

async function saveChat(chat) {
    await fs.writeFile(
        chatFile(chat.id),
        JSON.stringify(
            chat,
            null,
            2
        ),
        "utf8"
    );
}

// ============================================================
// JOBS
// ============================================================

const jobs = new Map();

function sendEvent(res, data) {
    try {
        res.write(
            JSON.stringify(data) +
            "\n"
        );
    } catch {}
}

// ============================================================
// HEALTH
// ============================================================

app.get("/health", async (req, res) => {
    await loadKeyStore();

    const active =
        getActiveKeyRecord();

    res.json({
        ok: true,
        service: "Gemini AI Agent",
        version: "4.0.0",
        model: MODEL,
        thinking: "low",
        activeKey:
            active?.name || null,
        savedKeys:
            keyStore.keys.length,
        agent: true,
        terminal: true,
        files: true,
        memory: true,
        stop: true,
        keyManager: true
    });
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Gemini AI Agent",
        version: "4.0.0",
        status: "online"
    });
});

// ============================================================
// FILE API
// ============================================================

app.get("/files", async (req, res) => {
    try {
        const project =
            safeProjectName(
                req.query.project ||
                "default"
            );

        const root =
            projectRoot(project);

        await fs.mkdir(
            root,
            {
                recursive: true
            }
        );

        const files =
            await listDirectory(root);

        res.json({
            ok: true,
            project,
            files
        });

    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


app.get("/file", async (req, res) => {
    try {
        const data =
            await readProjectFile(
                req.query.project ||
                    "default",
                req.query.path
            );

        res.json(data);

    } catch (err) {
        res.status(400).json({
            ok: false,
            error: err.message
        });
    }
});

// ============================================================
// CHAT
// ============================================================

app.post("/chats/new", async (req, res) => {
    const id =
        "chat_" +
        Date.now();

    const chat = {
        id,
        messages: []
    };

    await saveChat(chat);

    res.json({
        ok: true,
        id
    });
});


app.get("/chats", async (req, res) => {
    try {
        const files =
            await fs.readdir(
                CHATS_DIR
            );

        const chats = [];

        for (
            const file
            of files
        ) {
            if (
                !file.endsWith(".json")
            ) {
                continue;
            }

            try {
                const raw =
                    await fs.readFile(
                        path.join(
                            CHATS_DIR,
                            file
                        ),
                        "utf8"
                    );

                const chat =
                    JSON.parse(raw);

                chats.push({
                    id: chat.id,
                    messages:
                        chat.messages?.length ||
                        0
                });

            } catch {}
        }

        res.json({
            ok: true,
            chats
        });

    } catch (err) {
        res.status(500).json({
            ok: false,
            error: err.message
        });
    }
});


app.post("/chat", async (req, res) => {
    try {
        const chatId =
            String(
                req.body?.chatId ||
                "default"
            );

        const message =
            String(
                req.body?.message ||
                ""
            ).trim();

        if (!message) {
            return res.status(400).json({
                ok: false,
                error:
                    "Message is required."
            });
        }

        const chat =
            await loadChat(chatId);

        chat.messages.push({
            role: "user",
            content: message,
            timestamp: Date.now()
        });

        const recent =
            chat.messages.slice(-12);

        const prompt = `
You are a general AI Agent.

You help the user build:
- websites
- games
- UI
- software
- code
- files
- projects

Be practical and concise.

User request:
${message}

Recent conversation:
${recent
    .map(
        item =>
            `${item.role}: ${item.content}`
    )
    .join("\n")}
`;

        const answer =
            await askGemini(prompt);

        chat.messages.push({
            role: "assistant",
            content: answer,
            timestamp: Date.now()
        });

        await saveChat(chat);

        res.json({
            ok: true,
            message: answer
        });

    } catch (err) {
        res.status(500).json({
            ok: false,
            error:
                err.message ||
                "Chat failed."
        });
    }
});

// ============================================================
// AGENT
// ============================================================

app.post("/agent/stop", (req, res) => {
    const jobId =
        String(
            req.body?.jobId || ""
        );

    const job =
        jobs.get(jobId);

    if (job) {
        job.stopped = true;
    }

    res.json({
        ok: true,
        jobId
    });
});


app.post("/agent", async (req, res) => {
    const message =
        String(
            req.body?.message ||
            ""
        ).trim();

    const project =
        safeProjectName(
            req.body?.project ||
            "my-project"
        );

    if (!message) {
        return res.status(400).json({
            ok: false,
            error:
                "Message is required."
        });
    }

    const jobId =
        "job_" +
        Date.now() +
        "_" +
        crypto
            .randomBytes(3)
            .toString("hex");

    const job = {
        id: jobId,
        stopped: false
    };

    jobs.set(
        jobId,
        job
    );

    res.setHeader(
        "Content-Type",
        "application/x-ndjson; charset=utf-8"
    );

    res.setHeader(
        "Cache-Control",
        "no-cache"
    );

    res.setHeader(
        "Connection",
        "keep-alive"
    );

    sendEvent(
        res,
        {
            type: "connected",
            jobId,
            project
        }
    );

    try {
        await loadKeyStore();

        const active =
            getActiveKeyRecord();

        if (!active) {
            throw new Error(
                "No Gemini API key is available."
            );
        }

        sendEvent(
            res,
            {
                type: "start",
                project,
                keyId: active.id,
                keyName: active.name
            }
        );

        let conversation = "";

        for (
            let step = 1;
            step <= 8;
            step++
        ) {
            if (job.stopped) {
                sendEvent(
                    res,
                    {
                        type: "final",
                        message:
                            "تم إيقاف المهمة."
                    }
                );

                break;
            }

            sendEvent(
                res,
                {
                    type: "thinking",
                    step
                }
            );

            const activeNow =
                getActiveKeyRecord();

            if (!activeNow) {
                throw new Error(
                    "No active Gemini API key."
                );
            }

            const prompt = `
You are the brain of a general-purpose AI Agent.

The user wants:
${message}

Project name:
${project}

This is agent step ${step} of 8.

Your job is to reason about what needs to be done.

You have access to these tools conceptually:
- Files: create, read, modify and delete project files.
- Terminal: run safe project commands.
- Error checking and fixing.

Previous agent context:
${conversation.slice(-12000)}

Decide the next useful action.

If code or files need to be created, describe:
TOOL: write_file
PATH: relative/path
CONTENT:
<complete file content>

If a terminal command is needed, describe:
TOOL: terminal
COMMAND: node
ARGS: ["file.js"]

If you need to read a file:
TOOL: read_file
PATH: relative/path

If the work is complete:
FINAL:
<short explanation>

Do not invent tool results.
`;

            const answer =
                await askGemini(
                    prompt,
                    job
                );

            conversation +=
                "\nSTEP " +
                step +
                ":\n" +
                answer;

            sendEvent(
                res,
                {
                    type: "planning",
                    message:
                        answer.slice(
                            0,
                            1200
                        )
                }
            );

            // ------------------------------------------------
            // WRITE FILE
            // ------------------------------------------------

            const writeMatch =
                answer.match(
                    /TOOL:\s*write_file\s*[\r\n]+PATH:\s*(.+?)\s*[\r\n]+CONTENT:\s*([\s\S]*?)(?=\n(?:TOOL:|FINAL:)|$)/i
                );

            if (writeMatch) {
                const filePath =
                    writeMatch[1].trim();

                const content =
                    writeMatch[2];

                sendEvent(
                    res,
                    {
                        type: "tool_start",
                        tool: "write_file",
                        message:
                            `إنشاء الملف ${filePath}`
                    }
                );

                try {
                    const result =
                        await writeProjectFile(
                            project,
                            filePath,
                            content
                        );

                    sendEvent(
                        res,
                        {
                            type: "tool_result",
                            tool: "write_file",
                            result
                        }
                    );

                    conversation +=
                        "\nTOOL RESULT:\n" +
                        JSON.stringify(
                            result
                        );

                } catch (toolErr) {
                    sendEvent(
                        res,
                        {
                            type: "tool_error",
                            tool: "write_file",
                            error:
                                toolErr.message
                        }
                    );

                    conversation +=
                        "\nTOOL ERROR:\n" +
                        toolErr.message;
                }

                continue;
            }

            // ------------------------------------------------
            // READ FILE
            // ------------------------------------------------

            const readMatch =
                answer.match(
                    /TOOL:\s*read_file\s*[\r\n]+PATH:\s*(.+)/i
                );

            if (readMatch) {
                const filePath =
                    readMatch[1].trim();

                sendEvent(
                    res,
                    {
                        type: "tool_start",
                        tool: "read_file",
                        message:
                            `قراءة الملف ${filePath}`
                    }
                );

                try {
                    const result =
                        await readProjectFile(
                            project,
                            filePath
                        );

                    sendEvent(
                        res,
                        {
                            type: "tool_result",
                            tool: "read_file",
                            result: {
                                ok: true,
                                path:
                                    result.path,
                                content:
                                    result.content.slice(
                                        0,
                                        6000
                                    )
                            }
                        }
                    );

                    conversation +=
                        "\nFILE CONTENT:\n" +
                        result.content.slice(
                            0,
                            10000
                        );

                } catch (toolErr) {
                    sendEvent(
                        res,
                        {
                            type: "tool_error",
                            tool: "read_file",
                            error:
                                toolErr.message
                        }
                    );
                }

                continue;
            }

            // ------------------------------------------------
            // TERMINAL
            // ------------------------------------------------

            const terminalMatch =
                answer.match(
                    /TOOL:\s*terminal\s*[\r\n]+COMMAND:\s*(\S+)(?:\s*[\r\n]+ARGS:\s*(.*))?/i
                );

            if (terminalMatch) {
                const command =
                    terminalMatch[1].trim();

                let args = [];

                if (
                    terminalMatch[2]
                ) {
                    try {
                        args =
                            JSON.parse(
                                terminalMatch[2]
                            );

                        if (
                            !Array.isArray(
                                args
                            )
                        ) {
                            args = [];
                        }
                    } catch {
                        args =
                            terminalMatch[2]
                                .trim()
                                .split(/\s+/)
                                .filter(Boolean);
                    }
                }

                sendEvent(
                    res,
                    {
                        type: "tool_start",
                        tool: "terminal",
                        message:
                            `تشغيل ${command}`
                    }
                );

                try {
                    const result =
                        await runTerminal(
                            project,
                            command,
                            args
                        );

                    sendEvent(
                        res,
                        {
                            type: "tool_result",
                            tool: "terminal",
                            result
                        }
                    );

                    conversation +=
                        "\nTERMINAL RESULT:\n" +
                        JSON.stringify(
                            result
                        );

                } catch (toolErr) {
                    sendEvent(
                        res,
                        {
                            type: "tool_error",
                            tool: "terminal",
                            error:
                                toolErr.message
                        }
                    );

                    conversation +=
                        "\nTERMINAL ERROR:\n" +
                        toolErr.message;
                }

                continue;
            }

            // ------------------------------------------------
            // FINAL
            // ------------------------------------------------

            const finalMatch =
                answer.match(
                    /FINAL:\s*([\s\S]*)/i
                );

            if (finalMatch) {
                sendEvent(
                    res,
                    {
                        type: "final",
                        message:
                            finalMatch[1].trim()
                    }
                );

                break;
            }

            if (step === 8) {
                sendEvent(
                    res,
                    {
                        type: "final",
                        message:
                            answer
                    }
                );
            }
        }

        sendEvent(
            res,
            {
                type: "done"
            }
        );

    } catch (err) {

        const active =
            getActiveKeyRecord();

        const message =
            err?.message ||
            "حدث خطأ.";

        sendEvent(
            res,
            {
                type: "error",
                message,
                error: message,
                keyName:
                    err?.keyName ||
                    active?.name ||
                    null,
                quota:
                    !!err?.quota
            }
        );

        sendEvent(
            res,
            {
                type: "done"
            }
        );

    } finally {
        jobs.delete(jobId);

        try {
            res.end();
        } catch {}
    }
});

// ============================================================
// START
// ============================================================

await loadKeyStore();

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `Gemini AI Agent running on port ${PORT}`
        );
    }
);
