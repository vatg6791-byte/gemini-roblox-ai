import express from "express";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const app = express();

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.GEMINI_API_KEY;

const MODEL =
    process.env.GEMINI_MODEL || "gemini-3.8-flash";

const ai = API_KEY
    ? new GoogleGenAI({
        apiKey: API_KEY
    })
    : null;


/* =========================================================
   SERVER CONFIG
========================================================= */

app.use(
    express.json({
        limit: "2mb"
    })
);


/*
   GitHub Pages / browser -> Render

   No credentials are used.
*/

app.use(
    (req, res, next) => {

        res.setHeader(
            "Access-Control-Allow-Origin",
            "*"
        );

        res.setHeader(
            "Access-Control-Allow-Methods",
            "GET,POST,DELETE,OPTIONS"
        );

        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type"
        );

        if (req.method === "OPTIONS") {
            return res.sendStatus(204);
        }

        next();
    }
);


/* =========================================================
   PROJECT SANDBOX
========================================================= */

const PROJECT_ROOT =
    path.resolve("./projects");


await fs.mkdir(
    PROJECT_ROOT,
    {
        recursive: true
    }
);


function safeProjectName(name) {

    const clean =
        String(name || "default")
            .replace(
                /[^a-zA-Z0-9_-]/g,
                "_"
            )
            .slice(0, 50);

    return clean || "default";
}


function getProjectPath(project) {

    return path.join(
        PROJECT_ROOT,
        safeProjectName(project)
    );
}


function safePath(
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
   HELPERS
========================================================= */

function limitText(
    value,
    max = 12000
) {

    const text =
        String(value ?? "");

    if (text.length <= max) {
        return text;
    }

    return (
        text.slice(0, max) +
        "\n...[truncated]"
    );

}


function jsonResult(
    value
) {

    return {
        result:
            limitText(
                JSON.stringify(
                    value,
                    null,
                    2
                ),
                16000
            )
    };

}


/* =========================================================
   FILE TOOLS
========================================================= */

async function createProject(
    project
) {

    const root =
        getProjectPath(project);

    await fs.mkdir(
        root,
        {
            recursive: true
        }
    );

    return jsonResult({
        ok: true,
        project:
            safeProjectName(project)
    });

}


async function writeFileTool(
    project,
    filePath,
    content
) {

    const target =
        safePath(
            project,
            filePath
        );


    const text =
        String(content ?? "");


    if (text.length > 1000000) {

        throw new Error(
            "File is too large."
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
        text,
        "utf8"
    );


    return jsonResult({
        ok: true,
        path: filePath,
        bytes:
            Buffer.byteLength(
                text,
                "utf8"
            )
    });

}


async function readFileTool(
    project,
    filePath
) {

    const target =
        safePath(
            project,
            filePath
        );


    const content =
        await fs.readFile(
            target,
            "utf8"
        );


    return jsonResult({
        ok: true,
        path: filePath,
        content:
            limitText(
                content,
                30000
            )
    });

}


async function deleteFileTool(
    project,
    filePath
) {

    const target =
        safePath(
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


    return jsonResult({
        ok: true,
        path: filePath
    });

}


/* =========================================================
   FILE LIST
========================================================= */

async function listFilesRecursive(
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

        const fullPath =
            path.join(
                directory,
                entry.name
            );


        const relativePath =
            path.relative(
                base,
                fullPath
            );


        /*
           Never expose node_modules,
           .git or hidden system data.
        */

        if (
            entry.name === "node_modules" ||
            entry.name === ".git" ||
            entry.name.startsWith(".")
        ) {

            continue;

        }


        if (entry.isDirectory()) {

            const nested =
                await listFilesRecursive(
                    fullPath,
                    base
                );

            result.push(
                ...nested
            );

        } else {

            result.push(
                relativePath
            );

        }

    }


    return result;

}


async function listFilesTool(
    project
) {

    const root =
        getProjectPath(project);


    await fs.mkdir(
        root,
        {
            recursive: true
        }
    );


    const files =
        await listFilesRecursive(
            root
        );


    return jsonResult({
        ok: true,
        files
    });

}


/* =========================================================
   TERMINAL SAFETY
========================================================= */


/*
   The Agent does NOT get an unrestricted shell.

   Only these command families are allowed.
*/

const ALLOWED_COMMANDS =
    new Set([
        "node",
        "npm",
        "python",
        "python3"
    ]);


function validateTerminal(
    command,
    args
) {

    const cleanCommand =
        String(command || "")
            .trim();


    if (
        !ALLOWED_COMMANDS.has(
            cleanCommand
        )
    ) {

        throw new Error(
            `Command not allowed: ${cleanCommand}`
        );

    }


    if (!Array.isArray(args)) {

        throw new Error(
            "Terminal args must be an array."
        );

    }


    const safeArgs =
        args.map(
            value =>
                String(value)
        );


    /*
       Never allow shell syntax.
    */

    const dangerous =
        /[;&|><`$]|(\.\.)/;


    for (
        const arg of safeArgs
    ) {

        if (
            dangerous.test(arg)
        ) {

            throw new Error(
                "Unsafe terminal argument blocked."
            );

        }

    }


    /*
       Keep command arguments reasonably small.
    */

    if (
        safeArgs.join(" ").length > 4000
    ) {

        throw new Error(
            "Terminal command is too long."
        );

    }


    /*
       npm restrictions.
    */

    if (
        cleanCommand === "npm"
    ) {

        const first =
            safeArgs[0] || "";


        const allowedNpm =
            new Set([
                "install",
                "ci",
                "run",
                "test",
                "start",
                "build",
                "version"
            ]);


        if (
            !allowedNpm.has(first)
        ) {

            throw new Error(
                `npm command not allowed: ${first}`
            );

        }

    }


    return {
        command:
            cleanCommand,
        args:
            safeArgs
    };

}


async function terminalTool(
    project,
    command,
    args = []
) {

    const validated =
        validateTerminal(
            command,
            args
        );


    const projectPath =
        getProjectPath(project);


    await fs.mkdir(
        projectPath,
        {
            recursive: true
        }
    );


    try {

        const result =
            await execFileAsync(
                validated.command,
                validated.args,
                {
                    cwd: projectPath,

                    timeout: 30000,

                    maxBuffer:
                        1024 * 1024,

                    windowsHide: true
                }
            );


        return jsonResult({
            ok: true,
            command:
                validated.command,
            args:
                validated.args,
            stdout:
                limitText(
                    result.stdout,
                    12000
                ),
            stderr:
                limitText(
                    result.stderr,
                    12000
                ),
            exitCode: 0
        });

    } catch (error) {

        return jsonResult({
            ok: false,
            command:
                validated.command,
            args:
                validated.args,
            stdout:
                limitText(
                    error.stdout || "",
                    12000
                ),
            stderr:
                limitText(
                    error.stderr ||
                    error.message ||
                    "",
                    12000
                ),
            exitCode:
                typeof error.code === "number"
                    ? error.code
                    : 1
        });

    }

}


/* =========================================================
   TOOL DECLARATIONS
========================================================= */

const toolDeclarations = [

    {
        name: "create_project",

        description:
            "Create the current project directory.",

        parameters: {
            type: Type.OBJECT,

            properties: {},

            required: []
        }
    },


    {
        name: "list_files",

        description:
            "List all files currently inside the project.",

        parameters: {
            type: Type.OBJECT,

            properties: {},

            required: []
        }
    },


    {
        name: "read_file",

        description:
            "Read a text file from the current project before modifying it.",

        parameters: {

            type: Type.OBJECT,

            properties: {

                path: {
                    type: Type.STRING,
                    description:
                        "Relative project file path."
                }

            },

            required: [
                "path"
            ]
        }
    },


    {
        name: "write_file",

        description:
            "Create or completely replace a project text file.",

        parameters: {

            type: Type.OBJECT,

            properties: {

                path: {
                    type: Type.STRING,
                    description:
                        "Relative project file path."
                },

                content: {
                    type: Type.STRING,
                    description:
                        "Complete text content of the file."
                }

            },

            required: [
                "path",
                "content"
            ]
        }
    },


    {
        name: "delete_file",

        description:
            "Delete one file from the project.",

        parameters: {

            type: Type.OBJECT,

            properties: {

                path: {
                    type: Type.STRING,
                    description:
                        "Relative project file path."
                }

            },

            required: [
                "path"
            ]
        }
    },


    {
        name: "terminal",

        description:
            "Run a safe allowlisted command inside the current project directory. Use this to install project dependencies, run tests, build a project, or execute a project script.",

        parameters: {

            type: Type.OBJECT,

            properties: {

                command: {
                    type: Type.STRING,
                    description:
                        "Allowed command: node, npm, python, or python3."
                },

                args: {
                    type: Type.ARRAY,

                    items: {
                        type: Type.STRING
                    },

                    description:
                        "Command arguments."
                }

            },

            required: [
                "command",
                "args"
            ]
        }
    }

];


/* =========================================================
   GEMINI SYSTEM INSTRUCTION
========================================================= */

const SYSTEM_PROMPT = `

You are a real autonomous software development agent.

You are NOT a normal chatbot.

Your job is to turn the user's request into a working project.

You have access to real tools:

- create_project
- list_files
- read_file
- write_file
- delete_file
- terminal

WORKFLOW:

1. Understand the user's request.
2. Inspect the project when needed.
3. Plan internally.
4. Create or modify files using tools.
5. Run appropriate safe commands.
6. Read errors.
7. Fix errors.
8. Run verification again.
9. Continue until the task is complete or a real blocker exists.
10. Give the user a concise final summary.

IMPORTANT:

- Never claim a file exists unless you created or read it.
- Never claim a command succeeded unless the terminal result confirms it.
- Never invent tool results.
- If an error appears, investigate it.
- Read existing files before replacing important code.
- Keep all file paths inside the project.
- Do not expose API keys, environment variables, secrets, or credentials.
- Do not access the server filesystem outside the project.
- Do not use unsafe shell tricks.
- Do not use shell operators.
- Do not use unrestricted shell commands.
- Prefer simple, maintainable project structures.
- When building a website, create complete usable files.
- When building software, verify that the project actually runs.
- When possible, run a build, test, syntax check, or other appropriate verification.
- If verification fails, fix the project and verify again.

TOOL STRATEGY:

For a new project:
create_project
then write_file
then terminal
then inspect/fix
then verify.

For modifying an existing project:
list_files
then read_file for relevant files
then write_file
then verify.

Do not stop after a single tool call when more work is obviously required.

The user wants an Agent that actually performs work, not a pretend demonstration.

`;


/* =========================================================
   TOOL EXECUTOR
========================================================= */

async function executeTool(
    name,
    project,
    args
) {

    switch (name) {

        case "create_project":

            return await createProject(
                project
            );


        case "list_files":

            return await listFilesTool(
                project
            );


        case "read_file":

            return await readFileTool(
                project,
                args.path
            );


        case "write_file":

            return await writeFileTool(
                project,
                args.path,
                args.content
            );


        case "delete_file":

            return await deleteFileTool(
                project,
                args.path
            );


        case "terminal":

            return await terminalTool(
                project,
                args.command,
                args.args || []
            );


        default:

            throw new Error(
                `Unknown tool: ${name}`
            );

    }

}


/* =========================================================
   AGENT LOOP
========================================================= */

async function runAgent(
    project,
    userPrompt,
    emit
) {

    if (!ai) {

        throw new Error(
            "GEMINI_API_KEY is not configured."
        );

    }


    await createProject(
        project
    );


    let contents = [

        {
            role: "user",

            parts: [
                {
                    text:
                        `${SYSTEM_PROMPT}

PROJECT:
${project}

USER REQUEST:
${userPrompt.slice(0, 12000)}`
                }
            ]
        }

    ];


    const config = {

        tools: [
            {
                functionDeclarations:
                    toolDeclarations
            }
        ]

    };


    const MAX_STEPS = 20;


    for (
        let step = 1;
        step <= MAX_STEPS;
        step++
    ) {

        emit({
            type: "thinking",
            step,
            message:
                "Gemini is planning the next step."
        });


        const response =
            await ai.models.generateContent({

                model: MODEL,

                contents,

                config

            });


        const functionCalls =
            response.functionCalls || [];


        /*
           No tool call = final response.
        */

        if (
            functionCalls.length === 0
        ) {

            const finalText =
                response.text?.trim() ||
                "Task completed.";


            emit({
                type: "final",
                message:
                    finalText
            });


            return {
                ok: true,
                message:
                    finalText,
                steps:
                    step
            };

        }


        /*
           Preserve Gemini's model response
           in the conversation.
        */

        contents.push(
            response.candidates[0].content
        );


        for (
            const call of functionCalls
        ) {

            const toolName =
                call.name;


            const toolArgs =
                call.args || {};


            emit({
                type: "tool_start",

                step,

                tool:
                    toolName,

                args:
                    toolArgs,

                message:
                    toolName
            });


            let result;


            try {

                result =
                    await executeTool(
                        toolName,
                        project,
                        toolArgs
                    );


                emit({
                    type: "tool_result",

                    step,

                    tool:
                        toolName,

                    result
                });

            } catch (error) {

                result =
                    jsonResult({
                        ok: false,
                        error:
                            error.message
                    });


                emit({
                    type: "tool_error",

                    step,

                    tool:
                        toolName,

                    error:
                        error.message
                });

            }


            /*
               Return the real tool result
               back to Gemini.
            */

            contents.push({

                role: "user",

                parts: [

                    {

                        functionResponse: {

                            name:
                                toolName,

                            id:
                                call.id,

                            response:
                                result

                        }

                    }

                ]

            });

        }

    }


    throw new Error(
        "Agent reached the maximum number of steps."
    );

}


/* =========================================================
   STREAMING AGENT ENDPOINT
========================================================= */

app.post(
    "/agent",
    async (req, res) => {

        /*
           NDJSON streaming.

           Each line is one JSON event.
        */

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


        const project =
            safeProjectName(
                req.body?.project ||
                "default"
            );


        const prompt =
            req.body?.prompt;


        if (
            !prompt ||
            typeof prompt !== "string"
        ) {

            res.write(
                JSON.stringify({
                    type: "error",
                    error:
                        "Missing prompt"
                }) + "\n"
            );

            return res.end();

        }


        function emit(event) {

            try {

                res.write(
                    JSON.stringify(event) +
                    "\n"
                );

            } catch {
                /* client disconnected */
            }

        }


        emit({
            type: "start",
            project,
            model: MODEL
        });


        try {

            const result =
                await runAgent(
                    project,
                    prompt,
                    emit
                );


            emit({
                type: "done",
                ...result
            });

        } catch (error) {

            console.error(
                "Agent Error:",
                error
            );


            emit({
                type: "error",

                error:
                    error.message ||
                    "Agent request failed"
            });

        }


        res.end();

    }
);


/* =========================================================
   FILE API
========================================================= */

app.get(
    "/files",
    async (req, res) => {

        try {

            const project =
                safeProjectName(
                    req.query.project ||
                    "default"
                );


            const root =
                getProjectPath(
                    project
                );


            await fs.mkdir(
                root,
                {
                    recursive: true
                }
            );


            const files =
                await listFilesRecursive(
                    root
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
   SINGLE FILE API
========================================================= */

app.get(
    "/file",
    async (req, res) => {

        try {

            const project =
                safeProjectName(
                    req.query.project ||
                    "default"
                );


            const filePath =
                req.query.path;


            if (!filePath) {

                return res.status(400).json({
                    ok: false,
                    error:
                        "Missing path"
                });

            }


            const content =
                await fs.readFile(
                    safePath(
                        project,
                        filePath
                    ),
                    "utf8"
                );


            res.json({
                ok: true,
                project,
                path: filePath,
                content
            });

        } catch (error) {

            res.status(404).json({
                ok: false,
                error:
                    error.message
            });

        }

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

            service:
                "Gemini AI Agent",

            version:
                "2.0.0",

            status:
                "online",

            geminiConfigured:
                Boolean(API_KEY),

            model:
                MODEL,

            agent:
                true,

            agentLoop:
                true,

            terminal:
                true,

            files:
                true

        });

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
                "online",

            endpoints: [
                "/",
                "/health",
                "/agent",
                "/files",
                "/file"
            ]

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
            `Gemini AI Agent v2 running on port ${PORT}`
        );

    }
);
