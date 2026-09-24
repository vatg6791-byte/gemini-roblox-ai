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
const API_KEY = process.env.GEMINI_API_KEY;

const ai = API_KEY
    ? new GoogleGenAI({
        apiKey: API_KEY
    })
    : null;


/* =========================================================
   DIRECTORIES
========================================================= */

const PROJECT_ROOT =
    path.resolve("./projects");

const CHAT_ROOT =
    path.resolve("./chats");

await fs.mkdir(
    PROJECT_ROOT,
    { recursive: true }
);

await fs.mkdir(
    CHAT_ROOT,
    { recursive: true }
);


/* =========================================================
   CONFIG
========================================================= */

const MODEL =
    "gemini-3.8-flash";

/*
 * Low = أسرع.
 * نرفعها فقط إذا احتجنا لاحقًا.
 */
const THINKING_LEVEL =
    "low";

/*
 * الحد الأعلى لخطوات Agent.
 * أغلب المهام لن تحتاج أكثر من 1-3.
 */
const MAX_AGENT_STEPS =
    8;


/* =========================================================
   RUNNING JOBS
========================================================= */

const jobs =
    new Map();


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
   LIST PROJECT FILES
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


/*
 * نمنع الأوامر/الخيارات الخطرة.
 */
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
   ERROR TYPE
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
   GEMINI REQUEST
========================================================= */

async function askGemini(
    prompt,
    job
) {

    if (!ai) {

        throw new Error(
            "GEMINI_API_KEY is not configured."
        );
    }

    if (
        job?.stopped
    ) {

        throw new Error(
            "Agent stopped."
        );
    }


    /*
     * طلب واحد فقط.
     *
     * لا نعيد المحاولة تلقائيًا
     * إذا كانت الحصة اليومية انتهت.
     */

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


        return {

            model:
                MODEL,

            text:
                response.text?.trim() ||
                ""
        };

    } catch (error) {

        const info =
            getGeminiErrorInfo(
                error
            );

        /*
         * 429 quota اليومية:
         * لا نكرر الطلب.
         */
        if (
            info.is429
        ) {

            throw new Error(
                "QUOTA_EXCEEDED: وصلت حصة Gemini الحالية. انتظر إعادة ضبط الحصة أو استخدم مشروع Gemini بحصة متاحة."
            );
        }


        /*
         * 503:
         * محاولة واحدة فقط بعد انتظار قصير.
         * حتى لا نحرق quota.
         */
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

                    text:
                        retry.text?.trim() ||
                        ""
                };

            } catch (retryError) {

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

إذا طلب المستخدم:

"ابنِ موقعًا"

أنشئ الملفات المطلوبة مباشرة.

مثال:

index.html
style.css
script.js

لا تقرأ index.html مباشرة بعد كتابته إلا إذا كان هناك سبب.

========================

قاعدة الأخطاء:

إذا ظهر خطأ حقيقي:

1. افهم الخطأ.
2. أصلح الملف.
3. أعد الفحص.

لا تكرر نفس الأداة بلا سبب.

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


    /*
     * نرسل آخر 12 رسالة فقط.
     * هذا يقلل حجم السياق والسرعة.
     */

    const history =
        chat.messages
            .slice(-12)
            .map(
                message =>
                    `${message.role}: ${message.content}`
            )
            .join("\n");


    return `
${SYSTEM_PROMPT}

PROJECT:
${chat.project}

CHAT TITLE:
${chat.title}

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
   SEND NDJSON
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


    sendEvent(
        res,
        {
            type:
                "start",

            chatId:
                chat.id,

            project:
                chat.project
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

        } catch (error) {

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

                message:
                    action.message ||
                    "Planning next step"
            }
        );


        /*
         * انتهت المهمة.
         */

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


        /*
         * لا توجد أداة.
         */

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


        /*
         * تنفيذ الأداة.
         */

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


            /*
             * نخزن ملخصًا فقط.
             *
             * لا نضع محتوى ملف كامل داخل الذاكرة.
             */

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


            /*
             * نخزن الخطأ حتى يعرفه Agent
             * في الدورة التالية.
             */

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

            if (!ai) {

                return res.status(500).json({

                    ok:
                        false,

                    error:
                        "GEMINI_API_KEY is not configured."
                });
            }


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


            /*
             * اسم تلقائي للدردشة.
             */

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
   ROOT
========================================================= */

app.get(
    "/",
    (req, res) => {

        res.json({

            ok:
                true,

            service:
                "Gemini AI Agent",

            version:
                "3.0.0",

            model:
                MODEL,

            thinking:
                THINKING_LEVEL,

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
    (req, res) => {

        res.json({

            ok:
                true,

            geminiConfigured:
                Boolean(API_KEY),

            model:
                MODEL,

            thinking:
                THINKING_LEVEL,

            agent:
                true,

            terminal:
                true,

            files:
                true,

            memory:
                true,

            stop:
                true
        });
    }
);


/* =========================================================
   START
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
