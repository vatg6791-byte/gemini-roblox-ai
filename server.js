import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(express.json({ limit: "2mb" }));

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error("ERROR: GEMINI_API_KEY is missing.");
}

const ai = new GoogleGenAI({
    apiKey
});

/*
====================================================
 ROBLOX AI BUILDER V1
====================================================

 Gemini = العقل 🧠
 Roblox Executor = المنفذ ⚙️

 Gemini لا ينفذ Luau مباشرة.
 Gemini يرجع JSON منظم فقط.
====================================================
*/

const SYSTEM_PROMPT = `
أنت Roblox Studio AI Builder متقدم.

مهمتك مساعدة المستخدم في بناء وتطوير مشروع Roblox.

افهم الطلب باللغة العربية أو الإنجليزية، وحوله إلى
خطة تنفيذ منظمة.

يمكنك التعامل مع:

1. BUILDING
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

2. PART EDITING
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

3. UI
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

4. LIGHTING
- Lighting properties
- Atmosphere
- Bloom
- ColorCorrection
- SunRays
- DepthOfField
- Sky

5. GAME SYSTEMS
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

6. SCRIPTING
يمكنك إنشاء ServerScript أو LocalScript أو ModuleScript،
لكن أرجع محتوى السكربت كنص داخل JSON.
لا تشغّل كود بشكل مباشر.

7. PROJECT MANAGEMENT
- Rename
- Move
- Duplicate
- Delete
- Create folders
- Organize objects

8. UNDERSTANDING THE MAP
إذا أعطاك المستخدم معلومات عن العناصر الموجودة في الماب،
استخدمها في اتخاذ القرار.

إذا لم تكن المعلومات كافية، لا تخترع أسماء عناصر موجودة.
يمكنك إنشاء عناصر جديدة بأسماء واضحة.

====================================================
قواعد مهمة
====================================================

- أرجع JSON صالح فقط.
- لا تستخدم Markdown.
- لا تستخدم ```json.
- لا تكتب شرحًا خارج JSON.
- لا تنفذ كود Luau بنفسك.
- لا تطلب من Roblox تشغيل نص Gemini مباشرة.
- استخدم actions منظمة.
- اجعل الأوامر قابلة للتحقق قبل تنفيذها.
- إذا كان الطلب كبيرًا، قسمه إلى عدة actions.
- message يجب أن يكون وصفًا قصيرًا لما ستفعله.

====================================================
أنواع ACTIONS المسموحة
====================================================

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

====================================================
صيغة عامة
====================================================

{
  "message": "وصف مختصر",
  "actions": []
}

====================================================
create_instance
====================================================

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

====================================================
Part properties
====================================================

الحجم:

{
  "type": "set_property",
  "target": "Wall",
  "property": "Size",
  "value": [20, 10, 1]
}

الموقع:

{
  "type": "set_property",
  "target": "Wall",
  "property": "Position",
  "value": [0, 5, 0]
}

اللون:

{
  "type": "set_property",
  "target": "Wall",
  "property": "Color",
  "value": [255, 0, 0]
}

====================================================
GUI
====================================================

مثال:

{
  "type": "create_ui",
  "className": "TextButton",
  "name": "PlayButton",
  "parent": "ScreenGui",
  "properties": {
    "Text": "Play",
    "Size": [200, 50],
    "Position": [0.5, 0, 0.5, 0]
  }
}

====================================================
SCRIPT
====================================================

إذا طلب المستخدم سكربت:

{
  "type": "create_script",
  "className": "Script",
  "name": "MoneySystem",
  "parent": "ServerScriptService",
  "source": "ضع كود Luau هنا"
}

يجب أن يكون source نصًا فقط.

====================================================
الحذف
====================================================

{
  "type": "delete_instance",
  "target": "اسم العنصر"
}

====================================================
التعديل
====================================================

{
  "type": "set_property",
  "target": "اسم العنصر",
  "property": "Anchored",
  "value": true
}

====================================================
التراجع
====================================================

إذا طلب المستخدم التراجع عن آخر عملية:

{
  "type": "undo_last"
}

====================================================
المستخدم قد يطلب مشروعًا كاملًا
====================================================

مثال:

"سو لي متجر كامل"

لا ترد بكلام فقط.

أنشئ خطة actions تشمل:
- GUI
- الأزرار
- النصوص
- التنظيم
- السكربتات المطلوبة
- العناصر المطلوبة

لكن لا تنفذ شيئًا بنفسك.

====================================================
`;


// ================================================
// HOME
// ================================================

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Gemini Roblox AI Builder",
        version: "1.0.0",
        status: "online"
    });
});


// ================================================
// HEALTH
// ================================================

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        geminiConfigured: Boolean(apiKey)
    });
});


// ================================================
// ASK GEMINI
// ================================================

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

====================================================
MAP CONTEXT
====================================================

${typeof mapContext === "string"
    ? mapContext.slice(0, 50000)
    : ""}

====================================================
USER REQUEST
====================================================

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


        // إزالة Markdown لو Gemini أضافه رغم التعليمات
        text = text
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/\s*```$/i, "")
            .trim();


        let result;

        try {

            result = JSON.parse(text);

        } catch (parseError) {

            console.error("Invalid Gemini JSON:", text);

            return res.status(502).json({
                ok: false,
                error: "Gemini returned invalid JSON"
            });

        }


        // حماية إضافية
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


        res.json({

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

        res.status(500).json({

            ok: false,

            error: "Gemini request failed",

            details:
                process.env.NODE_ENV === "development"
                    ? String(error)
                    : undefined

        });

    }

});


// ================================================
// START SERVER
// ================================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Gemini Roblox AI Builder running on port ${PORT}`
    );

});
