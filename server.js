import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();

app.use(express.json({ limit: "1mb" }));

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "Gemini Roblox AI",
    status: "online"
  });
});

app.post("/ask", async (req, res) => {
  try {
    const prompt = req.body?.prompt;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({
        ok: false,
        error: "Missing prompt"
      });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.7-flash",
      contents: prompt
    });

    res.json({
      ok: true,
      response: response.text
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      error: "Gemini request failed"
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
