import express from "express";
import { GoogleGenAI } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const app = express();

app.use(express.json({ limit: "2mb" }));

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY;

const ai = apiKey
    ? new GoogleGenAI({ apiKey })
    : null;


/* ========================================================
   PROJECT SANDBOX
======================================================== */

const PROJECT_ROOT = path.resolve("./projects");

await fs.mkdir(PROJECT_ROOT, {
    recursive: true
});


function safeProjectName(name) {

    const clean = String(name || "default")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 50);

    return clean || "default";
}


function getProjectPath(project) {

    const clean = safeProjectName(project);

    return path.join(PROJECT_ROOT, clean);
}


function safePath(project, filePath) {

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
        throw new Error("Path outside project sandbox is not allowed.");
    }

    return target;
}


/* ========================================================
   FILE TOOLS
======================================================== */

async function createProject(project) {

    const root = getProjectPath(project);

    await fs.mkdir(root, {
        recursive: true
    });

    return `Project created: ${safeProjectName(project)}`;
}


async function writeFileTool(
    project,
    filePath,
    content
) {

    const target = safePath(
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

    return `File written: ${filePath}`;
}


async function readFileTool(
    project,
    filePath
) {

    const target = safePath(
        project,
        filePath
    );

    const content = await fs.readFile(
        target,
        "utf8"
    );

    return content;
}


async function deleteFileTool(
    project,
    filePath
) {

    const target = safePath(
        project,
        filePath
    );

    await fs.rm(
        target,
        {
            recursive: false,
            force: true
        }
    );

    return `File deleted: ${filePath}`;
}


/* ========================================================
   TERMINAL SANDBOX
======================================================== */

const ALLOWED_COMMANDS = new Set([
    "node",
    "npm",
    "npx",
    "python",
    "python3"
]);


async function terminalTool(
    project,
    command,
    args = []
) {

    const cleanCommand = String(command || "");

    if (!ALLOWED_COMMANDS.has(cleanCommand)) {

        throw new Error(
            `Command not allowed: ${cleanCommand}`
        );
    }

    if (!Array.isArray(args)) {
        throw new Error("Terminal args must be an array.");
    }

    const projectPath = getProjectPath(project);

    await fs.mkdir(
        projectPath,
        {
            recursive: true
        }
    );

    const safeArgs = args.map(
        value => String(value)
    );

    const result = await execFileAsync(
        cleanCommand,
        safeArgs,
        {
            cwd: projectPath,
            timeout: 30000,
            maxBuffer: 1024 * 1024
        }
    );

    return {
        stdout: result.stdout || "",
        stderr: result.stderr || ""
    };
}


/* ========================================================
   GEMINI AGENT PROMPT
======================================================== */

const SYSTEM_PROMPT = `
أنت Gemini AI Agent متقدم.

أنت لست مجرد Chatbot.

أنت Agent يستطيع التخطيط وتنفيذ المهام باستخدام أدوات.

يمكنك مساعدة المستخدم في:

- إنشاء مواقع
- إنشاء ألعاب
- إنشاء مشاريع برمجية
- تصميم UI
- كتابة HTML
- كتابة CSS
- كتابة JavaScript
- كتابة Python
- إنشاء الملفات
- تعديل الملفات
- قراءة الملفات
- تشغيل مشاريع
- فحص الأخطاء
- إصلاح الأخطاء

لديك أدوات:

1. create_project
إنشاء مشروع جديد.

2. write_file
إنشاء أو تعديل ملف.

3. read_file
قراءة ملف.

4. delete_file
حذف ملف.

5. terminal
تشغيل أوامر Terminal المسموحة داخل المشروع.

IMPORTANT:

- لا تدّعي أنك نفذت شيئًا إذا لم تنفذه أداة فعلًا.
- استخدم الأدوات عند الحاجة.
- لا تخترع نتيجة Terminal.
- إذا ظهر خطأ، اقرأ الخطأ وحاول إصلاحه.
- جميع الملفات يجب أن تبقى داخل مجلد المشروع.
- لا تحاول الوصول إلى ملفات النظام.
- لا تستخدم أوامر خطيرة.
- لا تحاول تجاوز Sandbox.
- لا تكشف مفاتيح API أو الأسرار.
- إذا طلب المستخدم بناء مشروع كامل، نفذ المهمة على مراحل.

أسلوبك:

افهم طلب المستخدم.
خطط.
استخدم الأدوات.
تحقق من النتيجة.
أصلح الأخطاء.
ثم أخبر المستخدم بما تم إنجازه.
`;


/* ========================================================
   TOOL EXECUTION
======================================================== */

async function runAgentTool(
    tool,
    project,
    input
) {

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
                input.args || []
            );


        default:

            throw new Error(
                `Unknown tool: ${tool}`
            );
    }
}


/* ========================================================
   AGENT
======================================================== */

app.post("/agent", async (req, res) => {

    try {

        if (!ai) {

            return res.status(500).json({
                ok: false,
                error: "GEMINI_API_KEY is not configured"
            });
        }


        const userPrompt = req.body?.prompt;

        const project =
            safeProjectName(
                req.body?.project || "default"
            );


        if (
            !userPrompt ||
            typeof userPrompt !== "string"
        ) {

            return res.status(400).json({
                ok: false,
                error: "Missing prompt"
            });
        }


        await createProject(
            project
        );


        const response =
            await ai.models.generateContent({

                model: "gemini-3.6-flash",

                contents: `
${SYSTEM_PROMPT}

PROJECT:
${project}

USER REQUEST:
${userPrompt.slice(0, 10000)}

Respond with JSON:

{
  "message": "what you want to do",
  "tool": null,
  "input": {}
}

Allowed tools:

create_project
write_file
read_file
delete_file
terminal

If no tool is required:

{
  "message": "your answer",
  "tool": null,
  "input": {}
}
`
            });


        let text =
            response.text?.trim() || "";


        text = text
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();


        let action;


        try {

            action = JSON.parse(text);

        } catch {

            return res.status(502).json({

                ok: false,

                error:
                    "Gemini returned invalid JSON",

                raw: text

            });
        }


        if (
            action.tool &&
            typeof action.tool === "string"
        ) {

            const result =
                await runAgentTool(
                    action.tool,
                    project,
                    action.input || {}
                );


            return res.json({

                ok: true,

                project,

                executed: true,

                tool: action.tool,

                message:
                    action.message ||
                    "Tool executed.",

                result

            });

        }


        return res.json({

            ok: true,

            project,

            executed: false,

            message:
                action.message ||
                "تم."

        });

    } catch (error) {

        console.error(
            "Agent Error:",
            error
        );

        return res.status(500).json({

            ok: false,

            error:
                error.message ||
                "Agent request failed"

        });
    }
});


/* ========================================================
   TEST ROUTES
======================================================== */

app.get("/", (req, res) => {

    res.json({

        ok: true,

        service:
            "Gemini AI Agent",

        version:
            "1.0.0",

        status:
            "online"

    });
});


app.get("/health", (req, res) => {

    res.json({

        ok: true,

        geminiConfigured:
            Boolean(apiKey),

        agent:
            true,

        terminal:
            true,

        files:
            true

    });
});


/* ========================================================
   START
======================================================== */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Gemini AI Agent running on port ${PORT}`
        );

    }
);
