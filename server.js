import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json({
    limit: "5mb"
}));

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY || "";

const PROJECT_ROOT = path.resolve("./projects");
const CHAT_ROOT = path.resolve("./chats");
const DATA_ROOT = path.resolve("./data");
const KEY_STORE_PATH = path.join(DATA_ROOT, "api-keys.json");

await fs.mkdir(PROJECT_ROOT, { recursive: true });
await fs.mkdir(CHAT_ROOT, { recursive: true });
await fs.mkdir(DATA_ROOT, { recursive: true });

const MODEL = "gemini-3.8-flash";
const THINKING_LEVEL = "low";
const MAX_AGENT_STEPS = 8;

const jobs = new Map();


// ============================================================
// SAFE NAMES / PATHS
// ============================================================

function safeName(value, fallback = "default") {
    const clean = String(value || fallback)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 80);

    return clean || fallback;
}

function getProjectPath(project) {
    return path.join(PROJECT_ROOT, safeName(project));
}

function getChatPath(chatId) {
    return path.join(
        CHAT_ROOT,
        `${safeName(chatId)}.json`
    );
}

function safeProjectPath(project, filePath) {
    const root = path.resolve(
        getProjectPath(project)
    );

    const target = path.resolve(
        root,
        String(filePath || "")
    );

    if (
        target !== root &&
        !target.startsWith(root + path.sep)
    ) {
        throw new Error(
            "Path outside project sandbox is not allowed."
        );
    }

    return target;
}


// ============================================================
// KEY MANAGER
// ============================================================

let keyStore = null;
let keyStoreWrite = Promise.resolve();

async function loadKeyStore() {

    if (keyStore) {
        return keyStore;
    }

    try {

        const raw = await fs.readFile(
            KEY_STORE_PATH,
            "utf8"
        );

        keyStore = JSON.parse(raw);

    } catch {

        keyStore = {
            activeKeyId: "primary",
            keys: []
        };
    }

    // Make sure primary Render key exists.
    if (API_KEY) {

        const primary =
            keyStore.keys.find(
                key => key.id === "primary"
            );

        if (primary) {

            // Always take the actual primary key
            // from Render environment.
            primary.apiKey = API_KEY;
            primary.enabled = true;
            primary.primary = true;
            primary.provider = "Google Gemini";

        } else {

            keyStore.keys.unshift({
                id: "primary",
                name: "Render Primary",
                provider: "Google Gemini",
                apiKey: API_KEY,
                primary: true,
                enabled: true,
                status: "ready",
                lastError: null,
                lastErrorAt: null,
                lastUsedAt: null,
                createdAt: Date.now()
            });
        }
    }

    if (
        !keyStore.activeKeyId ||
        !keyStore.keys.some(
            key =>
                key.id === keyStore.activeKeyId &&
                key.enabled
        )
    ) {

        keyStore.activeKeyId =
            API_KEY ? "primary" : null;
    }

    await saveKeyStore();

    return keyStore;
}


async function saveKeyStore() {

    if (!keyStore) {
        return;
    }

    keyStoreWrite =
        keyStoreWrite.then(async () => {

            await fs.writeFile(
                KEY_STORE_PATH,
                JSON.stringify(
                    keyStore,
                    null,
                    2
                ),
                "utf8"
            );

        });

    await keyStoreWrite;
}


async function getActiveKeyRecord() {

    const store =
        await loadKeyStore();

    const key =
        store.keys.find(
            item =>
                item.id === store.activeKeyId &&
                item.enabled &&
                item.apiKey
        );

    return key || null;
}


function maskKey(apiKey) {

    if (!apiKey) {
        return "";
    }

    const value = String(apiKey);

    if (value.length <= 10) {
        return "••••••••";
    }

    return (
        value.slice(0, 4) +
        "••••••••" +
        value.slice(-4)
    );
}


function publicKey(key, activeKeyId) {

    return {
        id: key.id,
        name: key.name,
        provider: key.provider,
        primary: Boolean(key.primary),
        enabled: Boolean(key.enabled),
        active: key.id === activeKeyId,
        maskedKey: maskKey(key.apiKey),
        status: key.status || "ready",
        lastError: key.lastError || null,
        lastErrorAt: key.lastErrorAt || null,
        lastUsedAt: key.lastUsedAt || null,
        createdAt: key.createdAt || null
    };
}


// ============================================================
// PROJECT TOOLS
// ============================================================

async function createProject(project) {

    await fs.mkdir(
        getProjectPath(project),
        { recursive: true }
    );

    return {
        ok: true,
        project: safeName(project)
    };
}


async function writeFileTool(
    project,
    filePath,
    content
) {

    const target =
        safeProjectPath(
            project,
            filePath
        );

    await fs.mkdir(
        path.dirname(target),
        { recursive: true }
    );

    const text =
        String(content ?? "");

    await fs.writeFile(
        target,
        text,
        "utf8"
    );

    return {
        ok: true,
        path: filePath,
        bytes: Buffer.byteLength(
            text,
            "utf8"
        )
    };
}


async function readFileTool(
    project,
    filePath
) {

    const target =
        safeProjectPath(
            project,
            filePath
        );

    const content =
        await fs.readFile(
            target,
            "utf8"
        );

    return {
        ok: true,
        path: filePath,
        content
    };
}


async function deleteFileTool(
    project,
    filePath
) {

    const target =
        safeProjectPath(
            project,
            filePath
        );

    await fs.rm(
        target,
        {
            force: true
        }
    );

    return {
        ok: true,
        path: filePath
    };
}


// ============================================================
// FILE LIST
// ============================================================

async function listFilesRecursive(
    directory,
    base = directory
) {

    const result = [];

    let entries = [];

    try {

        entries =
            await fs.readdir(
                directory,
                {
                    withFileTypes: true
                }
            );

    } catch {

        return result;
    }

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
            );

        if (entry.isDirectory()) {

            const children =
                await listFilesRecursive(
                    full,
                    base
                );

            result.push(
                ...children
            );

        } else {

            result.push(
                relative.replaceAll(
                    path.sep,
                    "/"
                )
            );
        }
    }

    return result;
}


// ============================================================
// TERMINAL
// ============================================================

const ALLOWED_COMMANDS =
    new Set([
        "node",
        "npm",
        "npx",
        "python",
        "python3"
    ]);


const BLOCKED_PATTERNS = [
    "rm -rf",
    "rm -r /",
    "shutdown",
    "reboot",
    "mkfs",
    "dd if=",
    ":(){",
    "fork bomb",
    "chmod 777",
    "chown",
    "/etc/",
    "/root/",
    "../"
];


async function terminalTool(
    project,
    command,
    args = []
) {

    const commandName =
        String(command || "")
            .trim();

    if (
        !ALLOWED_COMMANDS.has(
            commandName
        )
    ) {

        throw new Error(
            `Command not allowed: ${commandName}`
        );
    }

    const allText =
        [
            commandName,
            ...args
        ]
        .map(String)
        .join(" ");

    const lower =
        allText.toLowerCase();

    for (
        const blocked
        of BLOCKED_PATTERNS
    ) {

        if (
            lower.includes(
                blocked.toLowerCase()
            )
        ) {

            throw new Error(
                `Blocked terminal command: ${blocked}`
            );
        }
    }

    const cwd =
        getProjectPath(project);

    await fs.mkdir(
        cwd,
        {
            recursive: true
        }
    );

    try {

        const result =
            await execFileAsync(
                commandName,
                args.map(String),
                {
                    cwd,
                    timeout: 30000,
                    maxBuffer: 2 * 1024 * 1024
                }
            );

        return {
            ok: true,
            command: commandName,
            args,
            stdout: result.stdout || "",
            stderr: result.stderr || "",
            exitCode: 0
        };

    } catch (error) {

        return {
            ok: false,
            command: commandName,
            args,
            stdout: error.stdout || "",
            stderr:
                error.stderr ||
                error.message ||
                "",
            exitCode:
                typeof error.code === "number"
                    ? error.code
                    : 1
        };
    }
}


// ============================================================
// CHAT MEMORY
// ============================================================

async function loadChat(chatId) {

    try {

        const raw =
            await fs.readFile(
                getChatPath(chatId),
                "utf8"
            );

        return JSON.parse(raw);

    } catch {

        return {
            id: safeName(chatId),
            title: "New Chat",
            project: "default",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: []
        };
    }
}


async function saveChat(chat) {

    chat.updatedAt =
        Date.now();

    await fs.writeFile(
        getChatPath(chat.id),
        JSON.stringify(
            chat,
            null,
            2
        ),
        "utf8"
    );
}


// ============================================================
// GEMINI
// ============================================================

async function askGemini(
    prompt,
    job
) {

    if (
        job?.stopped
    ) {

        throw new Error(
            "Agent stopped."
        );
    }

    const activeKey =
        await getActiveKeyRecord();

    if (!activeKey) {

        throw new Error(
            "No active Gemini API key."
        );
    }

    if (!activeKey.apiKey) {

        throw new Error(
            "Active Gemini API key is empty."
        );
    }

    const activeAI =
        new GoogleGenAI({
            apiKey: activeKey.apiKey
        });

    console.log(
        `[GEMINI] Request started | key=${activeKey.name} | model=${MODEL}`
    );

    try {

        const response =
            await activeAI.models.generateContent({

                model: MODEL,

                contents: prompt,

                config: {

                    thinkingConfig: {
                        thinkingLevel:
                            THINKING_LEVEL
                    },

                    maxOutputTokens:
                        12000
                }
            });

        const text =
            response.text?.trim() || "";

        console.log(
            `[GEMINI] Success | key=${activeKey.name} | chars=${text.length}`
        );

        activeKey.lastUsedAt =
            Date.now();

        activeKey.lastError =
            null;

        activeKey.status =
            "ready";

        await saveKeyStore();

        return {
            model: MODEL,
            keyId: activeKey.id,
            keyName: activeKey.name,
            text
        };

    } catch (error) {

        const status =
            error?.status ||
            error?.code ||
            error?.response?.status ||
            "unknown";

        const message =
            error?.message ||
            error?.response?.data?.error?.message ||
            String(error);

        console.error(
            "========================================"
        );

        console.error(
            "[GEMINI ERROR]"
        );

        console.error(
            "Status:",
            status
        );

        console.error(
            "Key:",
            activeKey.name
        );

        console.error(
            "Model:",
            MODEL
        );

        console.error(
            "Message:",
            message
        );

        console.error(
            "========================================"
        );

        activeKey.lastError =
            message;

        activeKey.lastErrorAt =
            Date.now();

        const lower =
            String(message)
                .toLowerCase();

        if (
            status === 429 ||
            String(status) === "RESOURCE_EXHAUSTED" ||
            lower.includes("429") ||
            lower.includes("quota") ||
            lower.includes("resource_exhausted")
        ) {

            activeKey.status =
                "quota";

        } else {

            activeKey.status =
                "error";
        }

        await saveKeyStore();

        throw new Error(
            `Gemini request failed (${status}): ${message}`
        );
    }
}


// ============================================================
// AGENT PROMPT
// ============================================================

function buildAgentPrompt(
    project,
    userPrompt,
    memory
) {

    return `
You are an autonomous software development AI agent.

Your job is to actually build, modify, test and fix projects.

PROJECT:
${project}

USER REQUEST:
${userPrompt}

AVAILABLE TOOLS:

create_project(project)

write_file(project, path, content)

read_file(project, path)

delete_file(project, path)

terminal(project, command, args)

IMPORTANT RULES:

1. Understand the user's request.
2. Plan internally.
3. Use the available tools to actually create files.
4. Use Terminal when needed.
5. Run the project when possible.
6. Read errors.
7. Fix errors.
8. Verify the result.
9. Do not stop after only describing code.
10. Actually perform the work.
11. Do not repeatedly reread files that you just wrote unless needed.
12. Keep tool usage efficient.
13. Never expose API keys or secrets.
14. Work only inside the supplied project.
15. Prefer complete working implementations.
16. If something fails, diagnose and fix it.

RECENT MEMORY:
${JSON.stringify(
    memory.slice(-12),
    null,
    2
)}

Return ONLY valid JSON.

The JSON format must be:

{
  "message": "short explanation of what you are doing or finished",
  "actions": [
    {
      "tool": "create_project",
      "args": {}
    }
  ],
  "done": false
}

Allowed tools:

create_project
write_file
read_file
delete_file
terminal

If the work is complete:

{
  "message": "what was completed",
  "actions": [],
  "done": true
}
`;
}


// ============================================================
// JSON EXTRACTION
// ============================================================

function extractJSON(text) {

    if (!text) {
        throw new Error(
            "Gemini returned an empty response."
        );
    }

    let clean =
        String(text)
            .trim();

    clean =
        clean
            .replace(/^```json/i, "")
            .replace(/^```/i, "")
            .replace(/```$/i, "")
            .trim();

    try {

        return JSON.parse(clean);

    } catch {}

    const first =
        clean.indexOf("{");

    const last =
        clean.lastIndexOf("}");

    if (
        first !== -1 &&
        last !== -1 &&
        last > first
    ) {

        const possible =
            clean.slice(
                first,
                last + 1
            );

        return JSON.parse(
            possible
        );
    }

    throw new Error(
        "Gemini returned invalid JSON."
    );
}


// ============================================================
// TOOL EXECUTION
// ============================================================

async function executeAction(
    action,
    project
) {

    if (!action) {

        throw new Error(
            "Missing action."
        );
    }

    const tool =
        action.tool;

    const args =
        action.args || {};

    switch (tool) {

        case "create_project":

            return await createProject(
                args.project || project
            );

        case "write_file":

            return await writeFileTool(
                args.project || project,
                args.path,
                args.content
            );

        case "read_file":

            return await readFileTool(
                args.project || project,
                args.path
            );

        case "delete_file":

            return await deleteFileTool(
                args.project || project,
                args.path
            );

        case "terminal":

            return await terminalTool(
                args.project || project,
                args.command,
                args.args || []
            );

        default:

            throw new Error(
                `Unknown tool: ${tool}`
            );
    }
}


// ============================================================
// STREAM HELPER
// ============================================================

function sendEvent(
    res,
    event
) {

    res.write(
        JSON.stringify(event) +
        "\n"
    );
}


// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    async (req, res) => {

        try {

            const store =
                await loadKeyStore();

            const active =
                store.keys.find(
                    key =>
                        key.id ===
                        store.activeKeyId
                );

            res.json({

                ok: true,

                geminiConfigured:
                    Boolean(API_KEY),

                model: MODEL,

                thinking:
                    THINKING_LEVEL,

                activeKey:
                    active?.name ||
                    null,

                savedKeys:
                    store.keys.length,

                agent: true,

                terminal: true,

                files: true,

                memory: true,

                stop: true,

                keyManager: true
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.json({

            ok: true,

            service:
                "Gemini AI Agent",

            version:
                "4.0.0",

            model:
                MODEL,

            thinking:
                THINKING_LEVEL,

            status:
                "online"
        });
    }
);


// ============================================================
// KEY API
// ============================================================

app.get(
    "/keys",
    async (req, res) => {

        try {

            const store =
                await loadKeyStore();

            res.json({

                ok: true,

                activeKeyId:
                    store.activeKeyId,

                keys:
                    store.keys.map(
                        key =>
                            publicKey(
                                key,
                                store.activeKeyId
                            )
                    )
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ADD KEY
app.post(
    "/keys",
    async (req, res) => {

        try {

            const name =
                String(
                    req.body?.name ||
                    ""
                ).trim();

            const apiKey =
                String(
                    req.body?.apiKey ||
                    ""
                ).trim();

            if (!name) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "Key name is required."
                });
            }

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
                        "The API key looks too short."
                });
            }

            const store =
                await loadKeyStore();

            const id =
                `key_${Date.now()}_${Math.random()
                    .toString(36)
                    .slice(2, 8)}`;

            const newKey = {

                id,

                name:
                    name.slice(0, 80),

                provider:
                    "Google Gemini",

                apiKey,

                primary:
                    false,

                enabled:
                    true,

                status:
                    "ready",

                lastError:
                    null,

                lastErrorAt:
                    null,

                lastUsedAt:
                    null,

                createdAt:
                    Date.now()
            };

            store.keys.push(
                newKey
            );

            // New key becomes active immediately.
            store.activeKeyId =
                id;

            await saveKeyStore();

            console.log(
                `[KEYS] Added key: ${newKey.name}`
            );

            res.json({

                ok: true,

                message:
                    "Gemini key added and activated.",

                key:
                    publicKey(
                        newKey,
                        store.activeKeyId
                    )
            });

        } catch (error) {

            console.error(
                "[KEY ADD ERROR]",
                error.message
            );

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// USE KEY
app.post(
    "/keys/use",
    async (req, res) => {

        try {

            const id =
                String(
                    req.body?.id ||
                    ""
                ).trim();

            const store =
                await loadKeyStore();

            const key =
                store.keys.find(
                    item =>
                        item.id === id
                );

            if (!key) {

                return res.status(404).json({

                    ok: false,

                    error:
                        "Key not found."
                });
            }

            if (!key.apiKey) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "This key has no API key."
                });
            }

            key.enabled =
                true;

            store.activeKeyId =
                key.id;

            await saveKeyStore();

            console.log(
                `[KEYS] Activated key: ${key.name}`
            );

            res.json({

                ok: true,

                activeKeyId:
                    store.activeKeyId,

                key:
                    publicKey(
                        key,
                        store.activeKeyId
                    )
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// STOP KEY
app.post(
    "/keys/stop",
    async (req, res) => {

        try {

            const id =
                String(
                    req.body?.id ||
                    ""
                ).trim();

            const store =
                await loadKeyStore();

            const key =
                store.keys.find(
                    item =>
                        item.id === id
                );

            if (!key) {

                return res.status(404).json({

                    ok: false,

                    error:
                        "Key not found."
                });
            }

            if (key.primary) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "The Render Primary key cannot be stopped."
                });
            }

            key.enabled =
                false;

            key.status =
                "stopped";

            if (
                store.activeKeyId ===
                key.id
            ) {

                const primary =
                    store.keys.find(
                        item =>
                            item.primary &&
                            item.enabled &&
                            item.apiKey
                    );

                store.activeKeyId =
                    primary?.id ||
                    null;
            }

            await saveKeyStore();

            console.log(
                `[KEYS] Stopped key: ${key.name}`
            );

            res.json({

                ok: true,

                activeKeyId:
                    store.activeKeyId
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// DELETE KEY
app.delete(
    "/keys/:id",
    async (req, res) => {

        try {

            const id =
                String(
                    req.params.id ||
                    ""
                ).trim();

            const store =
                await loadKeyStore();

            const index =
                store.keys.findIndex(
                    item =>
                        item.id === id
                );

            if (index === -1) {

                return res.status(404).json({

                    ok: false,

                    error:
                        "Key not found."
                });
            }

            const key =
                store.keys[index];

            if (key.primary) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "The Render Primary key cannot be deleted."
                });
            }

            store.keys.splice(
                index,
                1
            );

            if (
                store.activeKeyId ===
                id
            ) {

                const primary =
                    store.keys.find(
                        item =>
                            item.primary &&
                            item.enabled &&
                            item.apiKey
                    );

                store.activeKeyId =
                    primary?.id ||
                    null;
            }

            await saveKeyStore();

            console.log(
                `[KEYS] Deleted key: ${key.name}`
            );

            res.json({

                ok: true,

                activeKeyId:
                    store.activeKeyId
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ============================================================
// NEW CHAT
// ============================================================

app.post(
    "/chats/new",
    async (req, res) => {

        const id =
            `chat_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2, 8)}`;

        const chat = {

            id,

            title:
                "New Chat",

            project:
                safeName(
                    req.body?.project ||
                    "default"
                ),

            createdAt:
                Date.now(),

            updatedAt:
                Date.now(),

            messages: []
        };

        await saveChat(
            chat
        );

        res.json({
            ok: true,
            chat
        });
    }
);


// ============================================================
// CHATS
// ============================================================

app.get(
    "/chats",
    async (req, res) => {

        try {

            const files =
                await fs.readdir(
                    CHAT_ROOT
                );

            const chats = [];

            for (
                const file
                of files
            ) {

                if (
                    !file.endsWith(
                        ".json"
                    )
                ) {
                    continue;
                }

                try {

                    const raw =
                        await fs.readFile(
                            path.join(
                                CHAT_ROOT,
                                file
                            ),
                            "utf8"
                        );

                    const chat =
                        JSON.parse(raw);

                    chats.push({
                        id: chat.id,
                        title:
                            chat.title ||
                            "New Chat",
                        project:
                            chat.project ||
                            "default",
                        createdAt:
                            chat.createdAt,
                        updatedAt:
                            chat.updatedAt
                    });

                } catch {}
            }

            chats.sort(
                (a, b) =>
                    (b.updatedAt || 0) -
                    (a.updatedAt || 0)
            );

            res.json({

                ok: true,

                chats
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ============================================================
// GET CHAT
// ============================================================

app.get(
    "/chat",
    async (req, res) => {

        try {

            const id =
                String(
                    req.query.id ||
                    ""
                ).trim();

            if (!id) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "Chat id is required."
                });
            }

            const chat =
                await loadChat(id);

            res.json({

                ok: true,

                chat
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ============================================================
// FILES
// ============================================================

app.get(
    "/files",
    async (req, res) => {

        try {

            const project =
                safeName(
                    req.query.project ||
                    "default"
                );

            const files =
                await listFilesRecursive(
                    getProjectPath(
                        project
                    )
                );

            res.json({

                ok: true,

                project,

                files
            });

        } catch (error) {

            res.status(500).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ============================================================
// SINGLE FILE
// ============================================================

app.get(
    "/file",
    async (req, res) => {

        try {

            const project =
                safeName(
                    req.query.project ||
                    "default"
                );

            const filePath =
                String(
                    req.query.path ||
                    ""
                );

            if (!filePath) {

                return res.status(400).json({

                    ok: false,

                    error:
                        "File path is required."
                });
            }

            const result =
                await readFileTool(
                    project,
                    filePath
                );

            res.json(result);

        } catch (error) {

            res.status(404).json({

                ok: false,

                error:
                    error.message
            });
        }
    }
);


// ============================================================
// STOP AGENT
// ============================================================

app.post(
    "/agent/stop",
    async (req, res) => {

        const jobId =
            String(
                req.body?.jobId ||
                ""
            ).trim();

        const job =
            jobs.get(jobId);

        if (job) {

            job.stopped =
                true;
        }

        res.json({

            ok: true,

            stopped:
                Boolean(job)
        });
    }
);


// ============================================================
// AGENT
// ============================================================

app.post(
    "/agent",
    async (req, res) => {

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

        const chatId =
            String(
                req.body?.chatId ||
                ""
            ).trim();

        const project =
            safeName(
                req.body?.project ||
                "default"
            );

        const userPrompt =
            String(
                req.body?.prompt ||
                ""
            ).trim();

        if (!userPrompt) {

            sendEvent(
                res,
                {
                    type: "error",
                    error:
                        "Prompt is required."
                }
            );

            sendEvent(
                res,
                {
                    type: "done"
                }
            );

            return res.end();
        }

        const jobId =
            `job_${Date.now()}_${Math.random()
                .toString(36)
                .slice(2, 8)}`;

        const job = {

            id: jobId,

            stopped:
                false,

            startedAt:
                Date.now()
        };

        jobs.set(
            jobId,
            job
        );

        let chat;

        if (chatId) {

            chat =
                await loadChat(
                    chatId
                );

        } else {

            chat = {

                id:
                    `chat_${Date.now()}_${Math.random()
                        .toString(36)
                        .slice(2, 8)}`,

                title:
                    userPrompt
                        .slice(0, 60),

                project,

                createdAt:
                    Date.now(),

                updatedAt:
                    Date.now(),

                messages: []
            };
        }

        chat.project =
            project;

        chat.messages.push({

            role:
                "user",

            content:
                userPrompt,

            createdAt:
                Date.now()
        });

        try {

            await createProject(
                project
            );

            const activeKey =
                await getActiveKeyRecord();

            sendEvent(
                res,
                {

                    type:
                        "connected",

                    jobId,

                    chatId:
                        chat.id,

                    project,

                    keyName:
                        activeKey?.name ||
                        null
                }
            );

            sendEvent(
                res,
                {

                    type:
                        "start",

                    message:
                        "Agent started."
                }
            );

            let memory =
                chat.messages
                    .slice(-12);

            let finalMessage =
                "";

            for (
                let step = 1;
                step <= MAX_AGENT_STEPS;
                step++
            ) {

                if (job.stopped) {

                    sendEvent(
                        res,
                        {
                            type:
                                "stopped",
                            jobId
                        }
                    );

                    break;
                }

                sendEvent(
                    res,
                    {

                        type:
                            "thinking",

                        step
                    }
                );

                const prompt =
                    buildAgentPrompt(
                        project,
                        userPrompt,
                        memory
                    );

                const result =
                    await askGemini(
                        prompt,
                        job
                    );

                const plan =
                    extractJSON(
                        result.text
                    );

                if (
                    plan.message
                ) {

                    sendEvent(
                        res,
                        {

                            type:
                                "planning",

                            step,

                            message:
                                plan.message
                        }
                    );
                }

                const actions =
                    Array.isArray(
                        plan.actions
                    )
                        ? plan.actions
                        : [];

                if (
                    actions.length === 0
                ) {

                    finalMessage =
                        plan.message ||
                        "Task completed.";

                    break;
                }

                for (
                    const action
                    of actions
                ) {

                    if (
                        job.stopped
                    ) {
                        break;
                    }

                    sendEvent(
                        res,
                        {

                            type:
                                "tool_start",

                            step,

                            tool:
                                action.tool,

                            args:
                                {
                                    ...action.args,
                                    apiKey:
                                        undefined
                                }
                        }
                    );

                    try {

                        const toolResult =
                            await executeAction(
                                action,
                                project
                            );

                        let safeResult =
                            toolResult;

                        // Don't send full file content
                        // back into the UI if read_file
                        // is used.
                        if (
                            action.tool ===
                            "read_file"
                        ) {

                            safeResult = {

                                ok:
                                    toolResult.ok,

                                path:
                                    toolResult.path,

                                contentLength:
                                    String(
                                        toolResult.content ||
                                        ""
                                    ).length,

                                content:
                                    toolResult.content
                            };
                        }

                        sendEvent(
                            res,
                            {

                                type:
                                    "tool_result",

                                step,

                                tool:
                                    action.tool,

                                result:
                                    safeResult
                            }
                        );

                        memory.push({

                            role:
                                "tool",

                            content:
                                `${action.tool}: success`
                        });

                    } catch (error) {

                        sendEvent(
                            res,
                            {

                                type:
                                    "tool_error",

                                step,

                                tool:
                                    action.tool,

                                error:
                                    error.message
                            }
                        );

                        memory.push({

                            role:
                                "tool",

                            content:
                                `${action.tool}: error: ${error.message}`
                        });
                    }
                }

                if (
                    plan.done
                ) {

                    finalMessage =
                        plan.message ||
                        "Task completed.";

                    break;
                }

                memory =
                    memory.slice(-12);
            }

            if (!finalMessage) {

                finalMessage =
                    "Agent finished its available steps.";
            }

            chat.messages.push({

                role:
                    "assistant",

                content:
                    finalMessage,

                createdAt:
                    Date.now()
            });

            await saveChat(
                chat
            );

            sendEvent(
                res,
                {

                    type:
                        "final",

                    jobId,

                    chatId:
                        chat.id,

                    message:
                        finalMessage
                }
            );

        } catch (error) {

            console.error(
                "[AGENT ERROR]",
                error.message
            );

            sendEvent(
                res,
                {

                    type:
                        "error",

                    jobId,

                    error:
                        error.message
                }
            );

        } finally {

            jobs.delete(
                jobId
            );

            sendEvent(
                res,
                {

                    type:
                        "done",

                    jobId
                }
            );

            res.end();
        }
    }
);


// ============================================================
// START
// ============================================================

app.listen(
    PORT,
    () => {

        console.log(
            `Gemini AI Agent running on port ${PORT}`
        );

        console.log(
            `[CONFIG] Gemini configured: ${Boolean(API_KEY)}`
        );

        console.log(
            `[CONFIG] Model: ${MODEL}`
        );
    }
);
