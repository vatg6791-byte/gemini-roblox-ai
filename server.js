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
    limit: "4mb"
}));

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const ai = API_KEY
    ? new GoogleGenAI({ apiKey: API_KEY })
    : null;


/* =========================================================
   DIRECTORIES
========================================================= */

const PROJECT_ROOT = path.resolve("./projects");
const CHAT_ROOT = path.resolve("./chats");

await fs.mkdir(PROJECT_ROOT, { recursive: true });
await fs.mkdir(CHAT_ROOT, { recursive: true });


/* =========================================================
   MODELS
========================================================= */

const MODELS = [
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash"
];


/* =========================================================
   RUNNING JOBS
========================================================= */

const jobs = new Map();


/* =========================================================
   SAFE NAMES
========================================================= */

function safeName(value, fallback = "default") {

    const clean = String(value || fallback)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 80);

    return clean || fallback;
}


/* =========================================================
   PROJECT PATH
========================================================= */

function projectPath(project) {

    return path.join(
        PROJECT_ROOT,
        safeName(project)
    );
}


/* =========================================================
   CHAT PATH
========================================================= */

function chatPath(chatId) {

    return path.join(
        CHAT_ROOT,
        `${safeName(chatId)}.json`
    );
}


/* =========================================================
   PATH SECURITY
========================================================= */

function safeProjectPath(project, filePath) {

    const root = path.resolve(
        projectPath(project)
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


/* =========================================================
   CHAT MEMORY
========================================================= */

async function loadChat(chatId) {

    try {

        const raw = await fs.readFile(
            chatPath(chatId),
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

    chat.updatedAt = Date.now();

    await fs.writeFile(
        chatPath(chat.id),
        JSON.stringify(
            chat,
            null,
            2
        ),
        "utf8"
    );
}


async function listChats() {

    const files = await fs.readdir(
        CHAT_ROOT
    );

    const chats = [];

    for (const file of files) {

        if (!file.endsWith(".json")) {
            continue;
        }

        try {

            const raw = await fs.readFile(
                path.join(CHAT_ROOT, file),
                "utf8"
            );

            const chat = JSON.parse(raw);

            chats.push({
                id: chat.id,
                title: chat.title,
                project: chat.project,
                updatedAt: chat.updatedAt,
                createdAt: chat.createdAt
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

async function createProject(project) {

    await fs.mkdir(
        projectPath(project),
        {
            recursive: true
        }
    );

    return true;
}


/* =========================================================
   FILE TOOLS
========================================================= */

async function writeFileTool(
    project,
    filePath,
    content
) {

    const target = safeProjectPath(
        project,
        filePath
    );

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
        path: filePath,
        bytes: Buffer.byteLength(
            String(content ?? ""),
            "utf8"
        )
    };
}


async function readFileTool(
    project,
    filePath
) {

    const target = safeProjectPath(
        project,
        filePath
    );

    const content = await fs.readFile(
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

    const target = safeProjectPath(
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


/* =========================================================
   LIST FILES
========================================================= */

async function getFiles(
    project,
    current = ""
) {

    const root = safeProjectPath(
        project,
        current
    );

    const result = [];

    async function walk(
        directory,
        relative
    ) {

        let entries = [];

        try {

            entries = await fs.readdir(
                directory,
                {
                    withFileTypes: true
                }
            );

        } catch {

            return;
        }

        for (const entry of entries) {

            const rel =
                path.join(
                    relative,
                    entry.name
                );

            if (
                entry.name === "node_modules" ||
                entry.name === ".git"
            ) {
                continue;
            }

            if (entry.isDirectory()) {

                result.push({
                    type: "folder",
                    path: rel
                });

                await walk(
                    path.join(
                        directory,
                        entry.name
                    ),
                    rel
                );

            } else {

                let size = 0;

                try {

                    const stat =
                        await fs.stat(
                            path.join(
                                directory,
                                entry.name
                            )
                        );

                    size = stat.size;

                } catch {}

                result.push({
                    type: "file",
                    path: rel,
                    size
                });
            }
        }
    }

    await walk(
        root,
        current
    );

    return result;
}


/* =========================================================
   SAFE TERMINAL
========================================================= */

const ALLOWED_COMMANDS = new Set([
    "node",
    "npm",
    "npx",
    "python",
    "python3"
]);


const BLOCKED_ARGUMENTS = [
    "rm -rf",
    "shutdown",
    "reboot",
    "mkfs",
    "dd if=",
    ":(){",
    "fork bomb"
];


async function terminalTool(
    project,
    command,
    args = [],
    job = null
) {

    if (
        !ALLOWED_COMMANDS.has(
            String(command)
        )
    ) {

        throw new Error(
            `Command not allowed: ${command}`
        );
    }

    if (!Array.isArray(args)) {

        throw new Error(
            "Terminal args must be an array."
        );
    }

    const serialized =
        `${command} ${args.join(" ")}`.toLowerCase();

    for (
        const blocked of BLOCKED_ARGUMENTS
    ) {

        if (
            serialized.includes(
                blocked
            )
        ) {

            throw new Error(
                "Blocked terminal command."
            );
        }
    }

    if (
        job &&
        job.stopped
    ) {

        throw new Error(
            "Agent stopped by user."
        );
    }

    const cwd =
        projectPath(project);

    await fs.mkdir(
        cwd,
        {
            recursive: true
        }
    );

    const safeArgs =
        args.map(
            value => String(value)
        );

    const result =
        await execFileAsync(
            String(command),
            safeArgs,
            {
                cwd,
                timeout: 30000,
                maxBuffer: 2 * 1024 * 1024
            }
        );

    return {
        stdout: result.stdout || "",
        stderr: result.stderr || ""
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
        job &&
        job.stopped
    ) {

        throw new Error(
            "Agent stopped by user."
        );
    }

    switch (tool) {

        case "create_project":

            await createProject(
                project
            );

            return {
                ok: true,
                message:
                    "Project created."
            };


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
   GEMINI CALL WITH RETRIES + FALLBACK
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

    let lastError = null;

    for (
        const model of MODELS
    ) {

        if (
            job &&
            job.stopped
        ) {

            throw new Error(
                "Agent stopped by user."
            );
        }

        for (
            let attempt = 1;
            attempt <= 3;
            attempt++
        ) {

            try {

                const response =
                    await ai.models.generateContent({

                        model,

                        contents: prompt

                    });

                return {
                    model,
                    text:
                        response.text?.trim() ||
                        ""
                };

            } catch (error) {

                lastError = error;

                const status =
                    error?.status ||
                    error?.code ||
                    "";

                const message =
                    String(
                        error?.message ||
                        ""
                    );

                const temporary =
                    status === 503 ||
                    status === "UNAVAILABLE" ||
                    message.includes("503") ||
                    message.includes("high demand") ||
                    message.includes("UNAVAILABLE");

                if (!temporary) {
                    throw error;
                }

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            1000 * attempt
                        )
                );
            }
        }
    }

    throw new Error(
        `Gemini temporarily unavailable: ${
            lastError?.message ||
            "503 UNAVAILABLE"
        }`
    );
}


/* =========================================================
   JSON PARSER
========================================================= */

function parseAgentJSON(text) {

    let clean =
        String(text || "")
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
        end !== -1 &&
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
   AGENT SYSTEM
========================================================= */

const SYSTEM_PROMPT = `
أنت Gemini AI Agent حقيقي.

أنت لست Chatbot فقط.

مهمتك هي تنفيذ طلب المستخدم باستخدام الأدوات المتاحة.

أنت قادر على:

- بناء مواقع
- بناء ألعاب
- بناء تطبيقات
- تصميم UI
- كتابة HTML
- كتابة CSS
- كتابة JavaScript
- كتابة Python
- إنشاء الملفات
- تعديل الملفات
- قراءة الملفات
- حذف الملفات عند الحاجة
- تشغيل المشاريع
- فحص الأخطاء
- إصلاح الأخطاء
- التحقق من النتيجة

TOOLS:

create_project
write_file
read_file
delete_file
terminal

قواعد مهمة:

1. لا تقل إنك نفذت شيئًا إلا إذا نفذته أداة فعلًا.

2. إذا كان المطلوب مشروعًا كاملًا، لا تتوقف بعد إنشاء ملف واحد.
استمر حتى يكتمل المشروع.

3. بعد كتابة الملفات، اقرأ الملفات المهمة عند الحاجة.

4. شغل المشروع أو فحوصاته باستخدام Terminal عند الحاجة.

5. إذا ظهر خطأ:
   - اقرأ الخطأ
   - حدد السبب
   - عدل الملف
   - أعد التشغيل
   - تحقق مرة أخرى

6. لا تستخدم أوامر Terminal خطيرة.

7. لا تصل إلى ملفات خارج المشروع.

8. لا تكشف مفاتيح API أو الأسرار.

9. إذا طلب المستخدم إيقاف المهمة، توقف.

10. إذا كانت المهمة مكتملة، أرسل finish=true.

11. لا تعيد تنفيذ نفس الأداة بلا سبب.

12. استخدم الأدوات بالتسلسل.

13. لا تخترع نتائج الأدوات.

14. عند مراجعة مشروع قديم:
   - اقرأ الذاكرة
   - اقرأ الملفات
   - افهم ما تم عمله
   - حدد المشاكل
   - أصلحها
   - تحقق من الإصلاح

أعد JSON فقط:

{
  "message": "شرح قصير لما ستفعله الآن",
  "tool": null,
  "input": {},
  "finish": false
}

أو:

{
  "message": "تم تنفيذ الخطوة",
  "tool": "write_file",
  "input": {
    "path": "index.html",
    "content": "..."
  },
  "finish": false
}

عند الانتهاء:

{
  "message": "تم الانتهاء والتحقق.",
  "tool": null,
  "input": {},
  "finish": true
}

الأدوات المسموحة فقط:

create_project
write_file
read_file
delete_file
terminal
`;


/* =========================================================
   BUILD CONTEXT
========================================================= */

async function buildContext(
    chat,
    userPrompt
) {

    const history =
        chat.messages
            .slice(-30)
            .map(
                message =>
                    `${message.role.toUpperCase()}: ${message.content}`
            )
            .join("\n\n");

    let files = [];

    try {

        files =
            await getFiles(
                chat.project
            );

    } catch {}

    return `
${SYSTEM_PROMPT}

PROJECT:
${chat.project}

CHAT:
${chat.title}

CURRENT PROJECT FILES:
${JSON.stringify(files, null, 2)}

PREVIOUS CONVERSATION:
${history || "No previous conversation."}

USER REQUEST:
${userPrompt}

قرر الخطوة التالية الآن.
`;
}


/* =========================================================
   STREAM EVENT
========================================================= */

function sendEvent(
    res,
    event
) {

    res.write(
        JSON.stringify(event) +
        "\n"
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

    const MAX_STEPS = 30;

    await createProject(
        chat.project
    );

    sendEvent(
        res,
        {
            type: "start",
            chatId: chat.id,
            project: chat.project
        }
    );

    for (
        let step = 1;
        step <= MAX_STEPS;
        step++
    ) {

        if (job.stopped) {

            sendEvent(
                res,
                {
                    type: "stopped",
                    message:
                        "تم إيقاف الـAgent."
                }
            );

            return;
        }

        sendEvent(
            res,
            {
                type: "thinking",
                step,
                message:
                    "Planning next step"
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
                    type: "error",
                    message:
                        error.message
                }
            );

            return;
        }

        job.model =
            answer.model;

        let action;

        try {

            action =
                parseAgentJSON(
                    answer.text
                );

        } catch (error) {

            sendEvent(
                res,
                {
                    type: "error",
                    message:
                        error.message,
                    raw:
                        answer.text
                }
            );

            return;
        }

        sendEvent(
            res,
            {
                type: "planning",
                step,
                model:
                    answer.model,
                message:
                    action.message ||
                    "Planning next step"
            }
        );

        if (
            action.finish === true ||
            !action.tool
        ) {

            const finalMessage =
                action.message ||
                "تم الانتهاء.";

            chat.messages.push({
                role: "assistant",
                content: finalMessage,
                time: Date.now()
            });

            await saveChat(chat);

            sendEvent(
                res,
                {
                    type: "final",
                    message:
                        finalMessage
                }
            );

            return;
        }

        sendEvent(
            res,
            {
                type: "tool_start",
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
                    type: "tool_result",
                    step,
                    tool:
                        action.tool,
                    result
                }
            );

            chat.messages.push({
                role: "agent",
                content:
                    `[${action.tool}] ${
                        action.message || ""
                    }`,
                time: Date.now()
            });

            await saveChat(chat);

        } catch (error) {

            sendEvent(
                res,
                {
                    type: "tool_error",
                    step,
                    tool:
                        action.tool,
                    error:
                        error.message
                }
            );

            chat.messages.push({
                role: "tool_error",
                content:
                    `[${action.tool}] ${error.message}`,
                time: Date.now()
            });

            await saveChat(chat);

            /*
             * لا نوقف الـAgent مباشرة.
             * نخليه يرجع لـGemini في الدورة التالية
             * ويشوف الخطأ ويحاول إصلاحه.
             */

            continue;
        }
    }

    sendEvent(
        res,
        {
            type: "error",
            message:
                "وصل الـAgent إلى الحد الأقصى للخطوات."
        }
    );
}


/* =========================================================
   START AGENT
========================================================= */

app.post(
    "/agent",
    async (req, res) => {

        try {

            if (!ai) {

                return res.status(500).json({
                    ok: false,
                    error:
                        "GEMINI_API_KEY is not configured"
                });
            }

            const prompt =
                String(
                    req.body?.prompt ||
                    ""
                ).trim();

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
                    ok: false,
                    error:
                        "Missing prompt"
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
             * أول رسالة تحدد اسم الدردشة
             */
            if (
                chat.title === "New Chat" &&
                chat.messages.length === 0
            ) {

                chat.title =
                    prompt
                        .replace(/\s+/g, " ")
                        .slice(0, 45);
            }

            chat.messages.push({
                role: "user",
                content: prompt,
                time: Date.now()
            });

            await saveChat(chat);

            const jobId =
                `${chatId}_${Date.now()}`;

            const job = {
                id: jobId,
                chatId,
                project,
                stopped: false,
                model: null
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
                    chatId
                }
            );

            req.on(
                "close",
                () => {

                    /*
                     * إذا أغلق المستخدم الاتصال،
                     * نطلب إيقاف المهمة.
                     */
                    job.stopped = true;

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
                    type: "done",
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

            if (!res.headersSent) {

                return res.status(500).json({
                    ok: false,
                    error:
                        error.message
                });
            }

            sendEvent(
                res,
                {
                    type: "error",
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
                ok: true,
                stopped: false,
                message:
                    "Job already finished."
            });
        }

        job.stopped = true;

        return res.json({
            ok: true,
            stopped: true
        });
    }
);


/* =========================================================
   CHATS
========================================================= */

app.get(
    "/chats",
    async (req, res) => {

        try {

            const chats =
                await listChats();

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


/* =========================================================
   GET CHAT
========================================================= */

app.get(
    "/chat",
    async (req, res) => {

        try {

            const chatId =
                safeName(
                    req.query?.id ||
                    "default"
                );

            const chat =
                await loadChat(
                    chatId
                );

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
                ).slice(0, 100);

            const project =
                safeName(
                    req.body?.project ||
                    id
                );

            const chat = {
                id,
                title,
                project,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                messages: []
            };

            await saveChat(
                chat
            );

            await createProject(
                project
            );

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

            const files =
                await getFiles(
                    project
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


/* =========================================================
   READ FILE
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

            const file =
                await readFileTool(
                    project,
                    filePath
                );

            res.json(file);

        } catch (error) {

            res.status(500).json({
                ok: false,
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
            ok: true,
            service:
                "Gemini AI Agent",
            version:
                "2.0.0",
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

            ok: true,

            geminiConfigured:
                Boolean(API_KEY),

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
