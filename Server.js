require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { tavily } = require('@tavily/core');

const app = express();
app.use(express.json());

// 1. Initialize Firebase Database
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 2. Initialize Search Client (Google GenAI package removed)
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// 3. The Core Chat Endpoint
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        // Search the web in the background using Tavily
        const searchData = await tvly.search(userMessage);
        const context = searchData.results.map(r => r.content).join('\n');

        // Pass the web context and user message to Gemini
        const prompt = `You are Alex, a highly intelligent and concise personal assistant. 
        You must always answer in 2 sentences or less. Do not use robotic jargon.
        Use this live web data to answer the user: ${context}
        
        User asks: ${userMessage}`;
        
        // 4. FIX: Use raw Fetch instead of the buggy Google GenAI package
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
        
        const aiRequest = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }]
            })
        });
        
        const aiData = await aiRequest.json();
        
        // Catch any raw Google API errors
        if (aiData.error) {
            console.error("Google API Error:", aiData.error);
            return res.status(500).json({ error: 'Google API failed' });
        }

        const aiResponse = aiData.candidates[0].content.parts[0].text;

        // Save to Firebase Database
        await db.collection('conversations').add({
            user: userMessage,
            ai: aiResponse,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send text back to the mobile app
        res.json({ reply: aiResponse });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

// Render dynamically assigns a port
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Alex Server running on port ${port}`));
