import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(express.json({ limit: "2mb" }));

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("ERROR: GEMINI_API_KEY is missing.");
}

const ai = new GoogleGenAI({
    apiKey: apiKey
});

const SYSTEM_PROMPT = `
أنت Roblox Studio AI Builder متقدم.

مهمتك مساعدة المستخدم في بناء وتطوير مشروع Roblox.

افهم طلب المستخدم بالعربية أو الإنجليزية وحوله إلى خطة
تنفيذ منظمة يمكن لبرنامج Roblox Executor تنفيذها.

يمكنك التعامل مع:

BUILDING:
- Parts
- Models
- Buildings
- Walls
- Floors
- Roads
- Stairs
- Doors
- Windows
- Decorations
- Spawn locations
- Folders

PART EDITING:
- Create
- Delete
- Move
- Resize
- Rotate
- Rename
- Color
- Material
- Transparency
- Anchored
- CanCollide
- CanTouch
- CanQuery

USER INTERFACE:
- ScreenGui
- Frame
- TextLabel
- TextButton
- ImageLabel
- ImageButton
- TextBox
- ScrollingFrame
- UIListLayout
- UIGridLayout
- UIPadding
- UICorner
- UIStroke
- UIGradient

LIGHTING:
- Lighting
- Atmosphere
- Bloom
- ColorCorrection
- SunRays
- DepthOfField
- Sky

GAME SYSTEMS:
- Money
- Leaderstats
- Teams
- Rounds
- Checkpoints
- Teleports
- Shops
- Doors
- Interactions
- NPC systems
- Game settings

SCRIPTING:
يمكنك إنشاء ServerScript أو LocalScript أو ModuleScript.
أرجع محتوى السكربت كنص داخل JSON.
لا تشغل الكود بنفسك.

PROJECT MANAGEMENT:
- Rename
- Move
- Duplicate
- Delete
- Create folders
- Organize objects

MAP UNDERSTANDING:
يمكن للمستخدم إرسال معلومات عن العناصر الموجودة في الماب.
استخدم هذه المعلومات عند اتخاذ القرارات.

إذا لم تكن المعلومات كافية، لا تخترع عناصر موجودة.
يمكنك إنشاء عناصر جديدة بأسماء واضحة.

IMPORTANT RULES:

- أرجع JSON صالح فقط.
- لا تستخدم Markdown.
- لا تكتب شرحًا خارج JSON.
- لا تستخدم code fences.
- لا تنفذ Luau بنفسك.
- لا تطلب تشغيل نص Gemini مباشرة.
- استخدم actions منظمة.
- اجعل كل عملية قابلة للتحقق قبل تنفيذها.
- إذا كان الطلب كبيرًا، قسمه إلى عدة actions.
- message يجب أن يكون وصفًا مختصرًا لما ستفعله.

ALLOWED ACTION TYPES:

create_instance
delete_instance
rename_instance
move_instance
resize_part
rotate_instance
set_property
set_attribute
clone_instance
create_folder
create_script
create_ui
create_ui_layout
create_ui_style
set_lighting
set_environment
undo_last

GENERAL FORMAT:

{
  "message": "وصف مختصر",
  "actions": []
}

CREATE INSTANCE:

{
  "type": "create_instance",
  "className": "Part",
  "name": "Wall",
  "parent": "Workspace",
  "properties": {
    "Anchored": true,
    "CanCollide": true
  }
}

SET PROPERTY:

{
  "type": "set_property",
  "target": "Wall",
  "property": "Size",
  "value": [20, 10, 1]
}

POSITION:

{
  "type": "set_property",
  "target": "Wall",
  "property": "Position",
  "value": [0, 5, 0]
}

COLOR:

{
  "type": "set_property",
  "target": "Wall",
  "property": "Color",
  "value": [255, 0, 0]
}

GUI:

{
  "type": "create_ui",
  "className": "TextButton",
  "name": "PlayButton",
  "parent": "ScreenGui",
  "properties": {
    "Text": "Play"
  }
}

SCRIPT:

{
  "type": "create_script",
  "className": "Script",
  "name": "MoneySystem",
  "parent": "ServerScriptService",
  "source": "ضع كود Luau هنا"
}

DELETE:

{
  "type": "delete_instance",
  "target": "اسم العنصر"
}

RENAME:

{
  "type": "rename_instance",
  "target": "Part",
  "newName": "Wall"
}

UNDO:

{
  "type": "undo_last"
}

إذا طلب المستخدم إنشاء مشروع كامل، قم بتقسيمه إلى actions صغيرة ومنظمة.

مثال:
إذا قال المستخدم:
سو لي متجر كامل

يمكنك إنشاء:
- واجهة المتجر
- الأزرار
- النصوص
- التنظيم
- العناصر المطلوبة
- السكربتات المطلوبة

لكن لا تنفذ أي شيء بنفسك.
`;

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Gemini Roblox AI Builder",
        version: "1.0.0",
        status: "online"
    });
});

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        geminiConfigured: Boolean(apiKey)
    });
});

app.post("/ask", async (req, res) => {
    try {
        const prompt = req.body?.prompt;
        const mapContext = req.body?.mapContext || "";

        if (!prompt || typeof prompt !== "string") {
            return res.status(400).json({
                ok: false,
                error: "Missing prompt"
            });
        }

        if (!apiKey) {
            return res.status(500).json({
                ok: false,
                error: "GEMINI_API_KEY is not configured"
            });
        }

        const fullPrompt = `
${SYSTEM_PROMPT}

MAP CONTEXT:
${typeof mapContext === "string" ? mapContext.slice(0, 50000) : ""}

USER REQUEST:
${prompt.slice(0, 10000)}
`;

        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: fullPrompt,
            config: {
                temperature: 0.2,
                responseMimeType: "application/json"
            }
        });

        let text = response.text?.trim() || "";

        text = text
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();

        let result;

        try {
            result = JSON.parse(text);
        } catch (error) {
            console.error("Invalid JSON from Gemini:", text);

            return res.status(502).json({
                ok: false,
                error: "Gemini returned invalid JSON"
            });
        }

        if (
            !result ||
            typeof result !== "object" ||
            !Array.isArray(result.actions)
        ) {
            return res.status(502).json({
                ok: false,
                error: "Invalid AI action format"
            });
        }

        return res.json({
            ok: true,
            result: {
                message:
                    typeof result.message === "string"
                        ? result.message
                        : "تم إنشاء خطة التنفيذ.",
                actions: result.actions
            }
        });

    } catch (error) {
        console.error("Gemini Error:", error);

        return res.status(500).json({
            ok: false,
            error: "Gemini request failed"
        });
    }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `Gemini Roblox AI Builder running on port ${PORT}`
    );
});
