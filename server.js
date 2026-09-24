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

/* =========================================================
   PRIMARY GEMINI KEY
========================================================= */

const PRIMARY_API_KEY =
    process.env.GEMINI_API_KEY || "";

/* =========================================================
   DIRECTORIES
========================================================= */

const PROJECT_ROOT =
    path.resolve("./projects");

const CHAT_ROOT =
    path.resolve("./chats");

const KEY_ROOT =
    path.resolve("./keys");

const KEY_FILE =
    path.join(
        KEY_ROOT,
        "keys.json"
    );

await fs.mkdir(
    PROJECT_ROOT,
    { recursive: true }
);

await fs.mkdir(
    CHAT_ROOT,
    { recursive: true }
);

await fs.mkdir(
    KEY_ROOT,
    { recursive: true }
);

/* =========================================================
   CONFIG
========================================================= */

const MODEL =
    "gemini-3.8-flash";

const THINKING_LEVEL =
    "low";

const MAX_AGENT_STEPS =
    8;

/* =========================================================
   JOBS
========================================================= */

const jobs =
    new Map();

/* =========================================================
   ACTIVE GEMINI KEY
========================================================= */

/*
 * null = استخدام المفتاح الأساسي من Render.
 *
 * إذا اختار المستخدم مفتاحًا محفوظًا:
 * currentKeyId يصبح ID المفتاح.
 */

let currentKeyId =
    null;

/* =========================================================
   KEY STORE
========================================================= */

async function loadKeys() {

    try {

        const raw =
            await fs.readFile(
                KEY_FILE,
                "utf8"
            );

        const data =
            JSON.parse(raw);

        if (
            !Array.isArray(data.keys)
        ) {

            return {
                keys: []
            };
        }

        return data;

    } catch {

        const initial = {
            keys: []
        };

        await fs.writeFile(
            KEY_FILE,
            JSON.stringify(
                initial,
                null,
                2
            ),
            "utf8"
        );

        return initial;
    }
}


async function saveKeys(
    data
) {

    await fs.writeFile(
        KEY_FILE,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );
}


function makeKeyId() {

    return (
        "key_" +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2, 9)
    );
}


function maskKey(
    key
) {

    const value =
        String(key || "");

    if (!value) {
        return "••••";
    }

    if (value.length <= 8) {
        return "••••••••";
    }

    return (
        value.slice(0, 4) +
        "••••••••" +
        value.slice(-4)
    );
}


/*
 * بيانات المفتاح التي نرسلها للواجهة.
 *
 * NEVER نرسل المفتاح الحقيقي.
 */

function publicKeyInfo(
    key
) {

    return {

        id:
            key.id,

        name:
            key.name,

        masked:
            maskKey(
                key.value
            ),

        enabled:
            key.enabled !== false,

        createdAt:
            key.createdAt,

        lastUsedAt:
            key.lastUsedAt || null
    };
}


/* =========================================================
   GEMINI CLIENT
========================================================= */

function getActiveKeyRecord(
    data
) {

    if (!currentKeyId) {

        return {

            id:
                "primary",

            name:
                "Render Primary",

            value:
                PRIMARY_API_KEY,

            enabled:
                Boolean(
                    PRIMARY_API_KEY
                ),

            primary:
                true
        };
    }

    const found =
        data.keys.find(
            key =>
                key.id ===
                currentKeyId
        );

    if (
        !found ||
        found.enabled === false
    ) {

        currentKeyId =
            null;

        return {

            id:
                "primary",

            name:
                "Render Primary",

            value:
                PRIMARY_API_KEY,

            enabled:
                Boolean(
                    PRIMARY_API_KEY
                ),

            primary:
                true
        };
    }

    return found;
}


function getAIClient() {

    /*
     * هذه الدالة تنشئ Client للمفتاح المستخدم حاليًا.
     */

    return loadKeys()
        .then(
            data => {

                const active =
                    getActiveKeyRecord(
                        data
                    );

                if (
                    !active.value
                ) {

                    throw new Error(
                        "لا يوجد مفتاح Gemini صالح حاليًا."
                    );
                }

                return {
                    ai:
                        new GoogleGenAI({
                            apiKey:
                                active.value
                        }),

                    key:
                        active
                };
            }
        );
}


/* =========================================================
   SAFE NAMES
========================================================= */

function safeName(
    value,
    fallback = "default"
) {

    const clean =
        String(
            value || fallback
        )
        .replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
        )
        .slice(
            0,
            80
        );

    return clean || fallback;
}


/* =========================================================
   PATHS
========================================================= */

function getProjectPath(
    project
) {

    return path.join(
        PROJECT_ROOT,
        safeName(project)
    );
}


function getChatPath(
    chatId
) {

    return path.join(
        CHAT_ROOT,
        `${safeName(chatId)}.json`
    );
}


/* =========================================================
   PATH SECURITY
========================================================= */

function safeProjectPath(
    project,
    filePath
) {

    const root =
        path.resolve(
            getProjectPath(project)
        );

    const target =
        path.resolve(
            root,
            String(filePath || "")
        );

    if (
        target !== root &&
        !target.startsWith(
            root + path.sep
        )
    ) {

        throw new Error(
            "Path outside project sandbox is not allowed."
        );
    }

    return target;
}


/* =========================================================
   CHAT MEMORY
========================================================= */

async function loadChat(
    chatId
) {

    try {

        const raw =
            await fs.readFile(
                getChatPath(chatId),
                "utf8"
            );

        return JSON.parse(
            raw
        );

    } catch {

        return {

            id:
                safeName(chatId),

            title:
                "New Chat",

            project:
                "default",

            createdAt:
                Date.now(),

            updatedAt:
                Date.now(),

            messages:
                []
        };
    }
}


async function saveChat(
    chat
) {

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


/* =========================================================
   CHAT LIST
========================================================= */

async function listChats() {

    const files =
        await fs.readdir(
            CHAT_ROOT
        );

    const chats = [];

    for (
        const file of files
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
                        CHAT_ROOT,
                        file
                    ),
                    "utf8"
                );

            const chat =
                JSON.parse(raw);

            chats.push({

                id:
                    chat.id,

                title:
                    chat.title,

                project:
                    chat.project,

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

    return chats;
}


/* =========================================================
   PROJECT
========================================================= */

async function createProject(
    project
) {

    await fs.mkdir(
        getProjectPath(project),
        {
            recursive: true
        }
    );

    return {
        ok: true
    };
}


/* =========================================================
   WRITE FILE
========================================================= */

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
        {
            recursive: true
        }
    );

    const text =
        String(
            content ?? ""
        );

    await fs.writeFile(
        target,
        text,
        "utf8"
    );

    return {

        ok: true,

        path:
            filePath,

        bytes:
            Buffer.byteLength(
                text,
                "utf8"
            )
    };
}


/* =========================================================
   READ FILE
========================================================= */

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

        path:
            filePath,

        content
    };
}


/* =========================================================
   DELETE FILE
========================================================= */

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

        path:
            filePath
    };
}


/* =========================================================
   FILE LIST
========================================================= */

async function getFiles(
    project
) {

    const root =
        getProjectPath(project);

    const result = [];

    async function walk(
        directory,
        relative
    ) {

        let entries;

        try {

            entries =
                await fs.readdir(
                    directory,
                    {
                        withFileTypes:
                            true
                    }
                );

        } catch {

            return;
        }

        for (
            const entry of entries
        ) {

            if (
                entry.name ===
                "node_modules"
            ) {
                continue;
            }

            if (
                entry.name ===
                ".git"
            ) {
                continue;
            }

            const rel =
                path.join(
                    relative,
                    entry.name
                );

            const full =
                path.join(
                    directory,
                    entry.name
                );

            if (
                entry.isDirectory()
            ) {

                result.push({

                    type:
                        "folder",

                    path:
                        rel
                });

                await walk(
                    full,
                    rel
                );

            } else {

                let size =
                    0;

                try {

                    const stat =
                        await fs.stat(
                            full
                        );

                    size =
                        stat.size;

                } catch {}

                result.push({

                    type:
                        "file",

                    path:
                        rel,

                    size
                });
            }
        }
    }

    await walk(
        root,
        ""
    );

    return result;
}


/* =========================================================
   TERMINAL
========================================================= */

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


function checkTerminalCommand(
    command,
    args
) {

    const text =
        [
            command,
            ...args
        ]
        .join(" ")
        .toLowerCase();

    for (
        const pattern
        of BLOCKED_PATTERNS
    ) {

        if (
            text.includes(pattern)
        ) {

            throw new Error(
                "Blocked terminal command."
            );
        }
    }
}


async function terminalTool(
    project,
    command,
    args,
    job
) {

    const cleanCommand =
        String(command || "");

    if (
        !ALLOWED_COMMANDS.has(
            cleanCommand
        )
    ) {

        throw new Error(
            `Command not allowed: ${cleanCommand}`
        );
    }

    if (
        !Array.isArray(args)
    ) {

        throw new Error(
            "Terminal args must be an array."
        );
    }

    checkTerminalCommand(
        cleanCommand,
        args
    );

    if (
        job?.stopped
    ) {

        throw new Error(
            "Agent stopped."
        );
    }

    const cwd =
        getProjectPath(project);

    await fs.mkdir(
        cwd,
        {
            recursive: true
        }
    );

    const safeArgs =
        args.map(
            value =>
                String(value)
        );

    const result =
        await execFileAsync(
            cleanCommand,
            safeArgs,
            {
                cwd,

                timeout:
                    30000,

                maxBuffer:
                    2 * 1024 * 1024
            }
        );

    return {

        ok: true,

        stdout:
            result.stdout ||
            "",

        stderr:
            result.stderr ||
            ""
    };
}


/* =========================================================
   TOOL EXECUTOR
========================================================= */

async function executeTool(
    tool,
    input,
    project,
    job
) {

    if (
        job?.stopped
    ) {

        throw new Error(
            "Agent stopped."
        );
    }

    switch (tool) {

        case "create_project":

            return await createProject(
                project
            );

        case "write_file":

            return await writeFileTool(
                project,
                input.path,
                input.content
            );

        case "read_file":

            return await readFileTool(
                project,
                input.path
            );

        case "delete_file":

            return await deleteFileTool(
                project,
                input.path
            );

        case "terminal":

            return await terminalTool(
                project,
                input.command,
                input.args || [],
                job
            );

        default:

            throw new Error(
                `Unknown tool: ${tool}`
            );
    }
}


/* =========================================================
   GEMINI ERROR
========================================================= */

function getGeminiErrorInfo(
    error
) {

    const message =
        String(
            error?.message ||
            error ||
            ""
        );

    const status =
        String(
            error?.status ||
            error?.code ||
            ""
        );

    const lower =
        message.toLowerCase();

    const is429 =
        status === "429" ||
        status ===
            "RESOURCE_EXHAUSTED" ||
        lower.includes(
            "resource_exhausted"
        ) ||
        lower.includes(
            "quota exceeded"
        ) ||
        lower.includes(
            "quota_exceeded"
        );

    const is503 =
        status === "503" ||
        status ===
            "UNAVAILABLE" ||
        lower.includes(
            "service unavailable"
        ) ||
        lower.includes(
            "high demand"
        );

    return {

        is429,

        is503,

        message,

        status
    };
}


/* =========================================================
   ASK GEMINI
========================================================= */

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

    const {
        ai,
        key
    } =
        await getAIClient();

    if (!ai) {

        throw new Error(
            "Gemini client unavailable."
        );
    }

    try {

        const response =
            await ai.models.generateContent({

                model:
                    MODEL,

                contents:
                    prompt,

                config: {

                    thinkingConfig: {

                        thinkingLevel:
                            THINKING_LEVEL
                    },

                    maxOutputTokens:
                        12000
                }
            });


        /*
         * نسجل آخر استخدام فقط.
         */

        if (
            key.id !== "primary"
        ) {

            try {

                const data =
                    await loadKeys();

                const found =
                    data.keys.find(
                        item =>
                            item.id ===
                            key.id
                    );

                if (found) {

                    found.lastUsedAt =
                        Date.now();

                    await saveKeys(
                        data
                    );
                }

            } catch {}
        }


        return {

            model:
                MODEL,

            keyId:
                key.id,

            keyName:
                key.name,

            text:
                response.text?.trim() ||
                ""
        };

    } catch (error) {

        const info =
            getGeminiErrorInfo(
                error
            );


        if (
            info.is429
        ) {

            throw new Error(
                `QUOTA_EXCEEDED: انتهت الحصة أو تم تجاوز حد الطلبات للمفتاح الحالي (${key.name}). يمكنك اختيار مفتاح آخر يدويًا من Keys إذا كان من مشروع Gemini آخر ولديه حصة متاحة.`
            );
        }


        if (
            info.is503
        ) {

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        2500
                    )
            );


            if (
                job?.stopped
            ) {

                throw new Error(
                    "Agent stopped."
                );
            }


            try {

                const retry =
                    await ai.models.generateContent({

                        model:
                            MODEL,

                        contents:
                            prompt,

                        config: {

                            thinkingConfig: {

                                thinkingLevel:
                                    THINKING_LEVEL
                            },

                            maxOutputTokens:
                                12000
                        }
                    });


                return {

                    model:
                        MODEL,

                    keyId:
                        key.id,

                    keyName:
                        key.name,

                    text:
                        retry.text?.trim() ||
                        ""
                };

            } catch {

                throw new Error(
                    "Gemini غير متاح مؤقتًا. حاول مرة أخرى بعد قليل."
                );
            }
        }


        throw error;
    }
}


/* =========================================================
   JSON PARSER
========================================================= */

function parseJSON(
    text
) {

    let clean =
        String(
            text || ""
        )
        .replace(
            /^```json\s*/i,
            ""
        )
        .replace(
            /^```\s*/i,
            ""
        )
        .replace(
            /\s*```$/i,
            ""
        )
        .trim();


    try {

        return JSON.parse(
            clean
        );

    } catch {}


    const start =
        clean.indexOf("{");

    const end =
        clean.lastIndexOf("}");


    if (
        start !== -1 &&
        end > start
    ) {

        return JSON.parse(
            clean.slice(
                start,
                end + 1
            )
        );
    }


    throw new Error(
        "Gemini returned invalid JSON."
    );
}


/* =========================================================
   SYSTEM PROMPT
========================================================= */

const SYSTEM_PROMPT = `
أنت AI Agent متخصص في بناء المشاريع البرمجية.

أنت تنفذ المهمة، ولست مجرد Chatbot.

يمكنك:

- بناء مواقع
- بناء ألعاب
- بناء تطبيقات
- إنشاء UI
- كتابة HTML
- كتابة CSS
- كتابة JavaScript
- كتابة Python
- إنشاء ملفات
- تعديل ملفات
- قراءة ملفات
- حذف ملفات عند الحاجة
- تشغيل المشروع
- فحص الأخطاء
- إصلاح الأخطاء

الأدوات:

create_project
write_file
read_file
delete_file
terminal

========================

قاعدة السرعة:

لا تستخدم read_file بعد كل write_file.

إذا كنت تعرف محتوى الملف الذي أنشأته، انتقل للخطوة التالية مباشرة.

لا تستخدم Terminal إلا إذا كان هناك سبب حقيقي.

لا تستدعِ أداة فقط لإظهار نشاط.

========================

قاعدة التنفيذ:

إذا طلب المستخدم بناء مشروع:

أنشئ الملفات المطلوبة مباشرة.

إذا كانت عدة ملفات مطلوبة، نفذها بأقل عدد ممكن من الخطوات.

========================

قاعدة الأخطاء:

إذا ظهر خطأ حقيقي:

1. افهم الخطأ.
2. أصلح الملف.
3. أعد الفحص.

========================

قاعدة الملفات:

كل الملفات داخل المشروع فقط.

لا تصل إلى ملفات النظام.

لا تستخدم أوامر Terminal خطيرة.

لا تكشف الأسرار أو مفاتيح API.

========================

قاعدة الذاكرة:

المحادثة الحالية جزء من ذاكرة المشروع.

ملفات المشروع هي المصدر الأساسي لحالة المشروع.

إذا كان المستخدم يكمل مشروعًا قديمًا:

افهم الملفات الحالية أولًا.

========================

أعد JSON فقط.

صيغة تنفيذ أداة:

{
  "message": "ماذا سأفعل الآن",
  "tool": "write_file",
  "input": {
    "path": "index.html",
    "content": "..."
  },
  "finish": false
}

صيغة إنهاء:

{
  "message": "تم تنفيذ المهمة والتحقق منها.",
  "tool": null,
  "input": {},
  "finish": true
}

========================

مهم جدًا:

في المهمة الواحدة حاول إنجاز أكبر قدر ممكن بأقل عدد من استدعاءات Gemini.

لا تطلب من Gemini نفسه التفكير مرة أخرى لكل ملف.
`;


/* =========================================================
   BUILD CONTEXT
========================================================= */

async function buildContext(
    chat,
    userPrompt
) {

    const files =
        await getFiles(
            chat.project
        );

    const history =
        chat.messages
            .slice(-12)
            .map(
                message =>
                    `${message.role}: ${message.content}`
            )
            .join("\n");


    const keys =
        await loadKeys();

    const active =
        getActiveKeyRecord(
            keys
        );


    return `
${SYSTEM_PROMPT}

PROJECT:
${chat.project}

CHAT TITLE:
${chat.title}

ACTIVE MODEL:
${MODEL}

ACTIVE KEY NAME:
${active.name}

PROJECT FILES:
${JSON.stringify(
    files,
    null,
    2
)}

RECENT MEMORY:
${history || "No previous messages."}

CURRENT USER REQUEST:
${userPrompt}

اختر الخطوة الضرورية التالية فقط.
`;
}


/* =========================================================
   NDJSON
========================================================= */

function sendEvent(
    res,
    event
) {

    res.write(
        JSON.stringify(
            event
        ) + "\n"
    );
}


/* =========================================================
   AGENT LOOP
========================================================= */

async function runAgent(
    res,
    chat,
    userPrompt,
    job
) {

    await createProject(
        chat.project
    );


    const keyData =
        await loadKeys();

    const activeKey =
        getActiveKeyRecord(
            keyData
        );


    sendEvent(
        res,
        {
            type:
                "start",

            chatId:
                chat.id,

            project:
                chat.project,

            keyName:
                activeKey.name
        }
    );


    for (
        let step = 1;
        step <= MAX_AGENT_STEPS;
        step++
    ) {

        if (
            job.stopped
        ) {

            sendEvent(
                res,
                {
                    type:
                        "stopped",

                    message:
                        "تم إيقاف الـAgent."
                }
            );

            return;
        }


        sendEvent(
            res,
            {
                type:
                    "thinking",

                step,

                message:
                    `Planning next step — Step ${step}`
            }
        );


        const context =
            await buildContext(
                chat,
                userPrompt
            );


        let answer;

        try {

            answer =
                await askGemini(
                    context,
                    job
                );

        } catch (error) {

            sendEvent(
                res,
                {
                    type:
                        "error",

                    message:
                        error.message
                }
            );

            return;
        }


        let action;

        try {

            action =
                parseJSON(
                    answer.text
                );

        } catch {

            sendEvent(
                res,
                {
                    type:
                        "error",

                    message:
                        "Gemini returned invalid JSON."
                }
            );

            return;
        }


        sendEvent(
            res,
            {
                type:
                    "planning",

                step,

                model:
                    answer.model,

                keyName:
                    answer.keyName,

                message:
                    action.message ||
                    "Planning next step"
            }
        );


        if (
            action.finish === true
        ) {

            const finalMessage =
                action.message ||
                "تم الانتهاء.";


            chat.messages.push({

                role:
                    "assistant",

                content:
                    finalMessage,

                time:
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

                    message:
                        finalMessage
                }
            );


            return;
        }


        if (
            !action.tool
        ) {

            const message =
                action.message ||
                "تم.";


            chat.messages.push({

                role:
                    "assistant",

                content:
                    message,

                time:
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

                    message
                }
            );


            return;
        }


        sendEvent(
            res,
            {
                type:
                    "tool_start",

                step,

                tool:
                    action.tool,

                input:
                    action.input || {},

                message:
                    action.message ||
                    `Running ${action.tool}`
            }
        );


        try {

            const result =
                await executeTool(
                    action.tool,
                    action.input || {},
                    chat.project,
                    job
                );


            sendEvent(
                res,
                {
                    type:
                        "tool_result",

                    step,

                    tool:
                        action.tool,

                    result
                }
            );


            let summary =
                action.message ||
                `Executed ${action.tool}`;


            if (
                action.tool ===
                "write_file"
            ) {

                summary +=
                    ` → ${action.input?.path || ""}`;
            }


            if (
                action.tool ===
                "terminal"
            ) {

                const stdout =
                    String(
                        result?.stdout ||
                        ""
                    )
                    .slice(
                        0,
                        2000
                    );

                if (
                    stdout
                ) {

                    summary +=
                        ` → ${stdout}`;
                }
            }


            chat.messages.push({

                role:
                    "agent",

                content:
                    summary,

                time:
                    Date.now()
            });


            await saveChat(
                chat
            );


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


            chat.messages.push({

                role:
                    "tool_error",

                content:
                    `${action.tool}: ${error.message}`,

                time:
                    Date.now()
            });


            await saveChat(
                chat
            );
        }
    }


    sendEvent(
        res,
        {
            type:
                "error",

            message:
                "توقّف الـAgent بعد الوصول للحد الآمن للخطوات."
        }
    );
}


/* =========================================================
   POST /agent
========================================================= */

app.post(
    "/agent",
    async (req, res) => {

        try {

            const prompt =
                String(
                    req.body?.prompt ||
                    ""
                )
                .trim();


            const chatId =
                safeName(
                    req.body?.chatId ||
                    "default"
                );


            const project =
                safeName(
                    req.body?.project ||
                    "default"
                );


            if (!prompt) {

                return res.status(400).json({

                    ok:
                        false,

                    error:
                        "Missing prompt."
                });
            }


            const chat =
                await loadChat(
                    chatId
                );


            chat.id =
                chatId;

            chat.project =
                project;


            if (
                chat.title ===
                    "New Chat" &&
                chat.messages.length ===
                    0
            ) {

                chat.title =
                    prompt
                        .replace(
                            /\s+/g,
                            " "
                        )
                        .slice(
                            0,
                            50
                        );
            }


            chat.messages.push({

                role:
                    "user",

                content:
                    prompt,

                time:
                    Date.now()
            });


            await saveChat(
                chat
            );


            const jobId =
                `${chatId}_${Date.now()}`;


            const job = {

                id:
                    jobId,

                chatId,

                project,

                stopped:
                    false
            };


            jobs.set(
                jobId,
                job
            );


            res.status(200);


            res.setHeader(
                "Content-Type",
                "application/x-ndjson; charset=utf-8"
            );


            res.setHeader(
                "Cache-Control",
                "no-cache, no-transform"
            );


            res.setHeader(
                "Connection",
                "keep-alive"
            );


            sendEvent(
                res,
                {
                    type:
                        "connected",

                    jobId,

                    chatId
                }
            );


            req.on(
                "close",
                () => {

                    job.stopped =
                        true;
                }
            );


            await runAgent(
                res,
                chat,
                prompt,
                job
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


            jobs.delete(
                jobId
            );


        } catch (error) {

            console.error(
                "Agent Error:",
                error
            );


            if (
                !res.headersSent
            ) {

                return res.status(500).json({

                    ok:
                        false,

                    error:
                        error.message
                });
            }


            sendEvent(
                res,
                {
                    type:
                        "error",

                    message:
                        error.message
                }
            );


            res.end();
        }
    }
);


/* =========================================================
   STOP AGENT
========================================================= */

app.post(
    "/agent/stop",
    async (req, res) => {

        const jobId =
            String(
                req.body?.jobId ||
                ""
            );


        const job =
            jobs.get(
                jobId
            );


        if (!job) {

            return res.json({

                ok:
                    true,

                stopped:
                    false
            });
        }


        job.stopped =
            true;


        res.json({

            ok:
                true,

            stopped:
                true
        });
    }
);


/* =========================================================
   NEW CHAT
========================================================= */

app.post(
    "/chats/new",
    async (req, res) => {

        try {

            const id =
                safeName(
                    req.body?.id ||
                    `chat_${Date.now()}`
                );


            const title =
                String(
                    req.body?.title ||
                    "New Chat"
                )
                .slice(
                    0,
                    100
                );


            const project =
                safeName(
                    req.body?.project ||
                    id
                );


            const chat = {

                id,

                title,

                project,

                createdAt:
                    Date.now(),

                updatedAt:
                    Date.now(),

                messages:
                    []
            };


            await saveChat(
                chat
            );


            await createProject(
                project
            );


            res.json({

                ok:
                    true,

                chat
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/* =========================================================
   CHATS
========================================================= */

app.get(
    "/chats",
    async (req, res) => {

        try {

            res.json({

                ok:
                    true,

                chats:
                    await listChats()
            });

        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/* =========================================================
   GET CHAT
========================================================= */

app.get(
    "/chat",
    async (req, res) => {

        try {

            const id =
                safeName(
                    req.query?.id ||
                    "default"
                );


            const chat =
                await loadChat(
                    id
                );


            res.json({

                ok:
                    true,

                chat
            });

        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/* =========================================================
   FILES
========================================================= */

app.get(
    "/files",
    async (req, res) => {

        try {

            const project =
                safeName(
                    req.query?.project ||
                    "default"
                );


            await createProject(
                project
            );


            res.json({

                ok:
                    true,

                project,

                files:
                    await getFiles(
                        project
                    )
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/* =========================================================
   FILE
========================================================= */

app.get(
    "/file",
    async (req, res) => {

        try {

            const project =
                safeName(
                    req.query?.project ||
                    "default"
                );


            const filePath =
                String(
                    req.query?.path ||
                    ""
                );


            const result =
                await readFileTool(
                    project,
                    filePath
                );


            res.json(
                result
            );


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/* =========================================================
   KEY API
========================================================= */

/*
 * GET /keys
 *
 * يعرض:
 * Primary
 * + المفاتيح المحفوظة
 *
 * بدون كشف المفاتيح الحقيقية.
 */

app.get(
    "/keys",
    async (req, res) => {

        try {

            const data =
                await loadKeys();

            const active =
                getActiveKeyRecord(
                    data
                );


            res.json({

                ok:
                    true,

                activeId:
                    active.id,

                primary: {

                    id:
                        "primary",

                    name:
                        "Render Primary",

                    enabled:
                        Boolean(
                            PRIMARY_API_KEY
                        ),

                    masked:
                        maskKey(
                            PRIMARY_API_KEY
                        ),

                    primary:
                        true
                },

                keys:
                    data.keys.map(
                        publicKeyInfo
                    )
            });

        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
 * POST /keys
 *
 * إضافة مفتاح جديد.
 */

app.post(
    "/keys",
    async (req, res) => {

        try {

            const name =
                String(
                    req.body?.name ||
                    ""
                )
                .trim()
                .slice(
                    0,
                    80
                );


            const value =
                String(
                    req.body?.key ||
                    ""
                )
                .trim();


            if (!name) {

                return res.status(400).json({

                    ok:
                        false,

                    error:
                        "اكتب اسم المفتاح."
                });
            }


            if (!value) {

                return res.status(400).json({

                    ok:
                        false,

                    error:
                        "أدخل مفتاح Gemini."
                });
            }


            if (
                value.length < 20
            ) {

                return res.status(400).json({

                    ok:
                        false,

                    error:
                        "المفتاح يبدو غير صالح."
                });
            }


            const data =
                await loadKeys();


            /*
             * منع إضافة نفس المفتاح مرتين.
             */

            const duplicate =
                data.keys.find(
                    item =>
                        item.value ===
                        value
                );


            if (duplicate) {

                return res.status(409).json({

                    ok:
                        false,

                    error:
                        "هذا المفتاح مضاف بالفعل."
                });
            }


            const newKey = {

                id:
                    makeKeyId(),

                name,

                value,

                enabled:
                    true,

                createdAt:
                    Date.now(),

                lastUsedAt:
                    null
            };


            data.keys.push(
                newKey
            );


            await saveKeys(
                data
            );


            res.json({

                ok:
                    true,

                key:
                    publicKeyInfo(
                        newKey
                    )
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
 * POST /keys/use
 *
 * اختيار مفتاح يدويًا.
 */

app.post(
    "/keys/use",
    async (req, res) => {

        try {

            const id =
                String(
                    req.body?.id ||
                    ""
                );


            /*
             * الرجوع إلى مفتاح Render.
             */

            if (
                id === "primary"
            ) {

                currentKeyId =
                    null;


                return res.json({

                    ok:
                        true,

                    activeId:
                        "primary",

                    activeName:
                        "Render Primary"
                });
            }


            const data =
                await loadKeys();


            const key =
                data.keys.find(
                    item =>
                        item.id === id
                );


            if (!key) {

                return res.status(404).json({

                    ok:
                        false,

                    error:
                        "المفتاح غير موجود."
                });
            }


            if (
                key.enabled === false
            ) {

                return res.status(400).json({

                    ok:
                        false,

                    error:
                        "هذا المفتاح متوقف. فعّله أولًا."
                });
            }


            currentKeyId =
                key.id;


            key.lastUsedAt =
                Date.now();


            await saveKeys(
                data
            );


            res.json({

                ok:
                    true,

                activeId:
                    key.id,

                activeName:
                    key.name
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
 * POST /keys/stop
 *
 * إيقاف/تعطيل مفتاح محفوظ.
 */

app.post(
    "/keys/stop",
    async (req, res) => {

        try {

            const id =
                String(
                    req.body?.id ||
                    ""
                );


            const data =
                await loadKeys();


            const key =
                data.keys.find(
                    item =>
                        item.id === id
                );


            if (!key) {

                return res.status(404).json({

                    ok:
                        false,

                    error:
                        "المفتاح غير موجود."
                });
            }


            key.enabled =
                false;


            /*
             * إذا كان هو المستخدم حاليًا
             * نرجع للـPrimary.
             */

            if (
                currentKeyId ===
                key.id
            ) {

                currentKeyId =
                    null;
            }


            await saveKeys(
                data
            );


            res.json({

                ok:
                    true,

                activeId:
                    currentKeyId ||
                    "primary"
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
 * POST /keys/enable
 *
 * إعادة تشغيل مفتاح محفوظ.
 */

app.post(
    "/keys/enable",
    async (req, res) => {

        try {

            const id =
                String(
                    req.body?.id ||
                    ""
                );


            const data =
                await loadKeys();


            const key =
                data.keys.find(
                    item =>
                        item.id === id
                );


            if (!key) {

                return res.status(404).json({

                    ok:
                        false,

                    error:
                        "المفتاح غير موجود."
                });
            }


            key.enabled =
                true;


            await saveKeys(
                data
            );


            res.json({

                ok:
                    true,

                key:
                    publicKeyInfo(
                        key
                    )
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/*
 * DELETE /keys/:id
 *
 * حذف مفتاح محفوظ.
 */

app.delete(
    "/keys/:id",
    async (req, res) => {

        try {

            const id =
                String(
                    req.params.id ||
                    ""
                );


            const data =
                await loadKeys();


            const before =
                data.keys.length;


            data.keys =
                data.keys.filter(
                    item =>
                        item.id !== id
                );


            if (
                data.keys.length ===
                before
            ) {

                return res.status(404).json({

                    ok:
                        false,

                    error:
                        "المفتاح غير موجود."
                });
            }


            if (
                currentKeyId ===
                id
            ) {

                currentKeyId =
                    null;
            }


            await saveKeys(
                data
            );


            res.json({

                ok:
                    true,

                activeId:
                    currentKeyId ||
                    "primary"
            });


        } catch (error) {

            res.status(500).json({

                ok:
                    false,

                error:
                    error.message
            });
        }
    }
);


/* =========================================================
   ROOT
========================================================= */

app.get(
    "/",
    async (req, res) => {

        const data =
            await loadKeys();

        const active =
            getActiveKeyRecord(
                data
            );


        res.json({

            ok:
                true,

            service:
                "Gemini AI Agent",

            version:
                "4.0.0",

            model:
                MODEL,

            thinking:
                THINKING_LEVEL,

            activeKey:
                active.name,

            status:
                "online"
        });
    }
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    async (req, res) => {

        const data =
            await loadKeys();

        const active =
            getActiveKeyRecord(
                data
            );


        res.json({

            ok:
                true,

            geminiConfigured:
                Boolean(
                    PRIMARY_API_KEY
                ),

            model:
                MODEL,

            thinking:
                THINKING_LEVEL,

            activeKey:
                active.name,

            savedKeys:
                data.keys.length,

            agent:
                true,

            terminal:
                true,

            files:
                true,

            memory:
                true,

            stop:
                true,

            keyManager:
                true
        });
    }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Gemini AI Agent running on port ${PORT}`
        );

    }
);
