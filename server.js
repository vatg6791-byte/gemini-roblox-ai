import express from "express";

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        ok: true,
        service: "Gemini Roblox AI",
        status: "online"
    });
});

app.post("/ask", (req, res) => {
    const prompt = req.body?.prompt;

    if (!prompt) {
        return res.status(400).json({
            ok: false,
            error: "Missing prompt"
        });
    }

    res.json({
        ok: true,
        received: prompt
    });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
});
