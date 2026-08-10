require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { tavily } = require('@tavily/core');

const app = express();
app.use(express.json());
// Bypass CORS security blocks
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});
// 1. Initialize Firebase Database
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 2. Initialize Search Client
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// 3. The Core Chat Endpoint
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        // Search the web in the background using Tavily
        const searchData = await tvly.search(userMessage);
        const context = searchData.results.map(r => r.content).join('\n');

        // Pass the web context and user message to the AI
        const prompt = `You are Alex, a highly intelligent and concise personal assistant. 
        You must always answer in 2 sentences or less. Do not use robotic jargon.
        Use this live web data to answer the user: ${context}
        
        User asks: ${userMessage}`;
        
        // 4. FIX: Use Groq to bypass the Google bug
        const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
        
        const aiRequest = await fetch(groqUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant', 
                messages: [{ role: 'user', content: prompt }]
            })
        });
        
        const aiData = await aiRequest.json();
        
        if (aiData.error) {
            console.error("AI API Error:", aiData.error);
            return res.status(500).json({ error: 'AI failed' });
        }

        const aiResponse = aiData.choices[0].message.content;

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
