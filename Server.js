require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

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

// 2. The Core Chat Endpoint (Now with Memory)
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        // --- STEP A: Fetch Memory from Firebase ---
        // Grab the last 5 conversations from the database to use as context
        const historySnapshot = await db.collection('conversations')
            .orderBy('timestamp', 'desc')
            .limit(5)
            .get();

        let pastMessages = [];
        historySnapshot.forEach(doc => {
            const data = doc.data();
            // Because we pulled them newest-first, we push them to the front of the array
            // so they read in correct chronological order for the AI
            pastMessages.unshift({ role: 'assistant', content: data.ai });
            pastMessages.unshift({ role: 'user', content: data.user });
        });

        // --- STEP B: Build the AI's Brain Context ---
        const messagesArray = [
            { 
                role: 'system', 
                content: 'You are Alex, a highly intelligent and concise personal assistant. You must always answer in 2 sentences or less. Do not use robotic jargon. Remember the context of the prior conversation.' 
            },
            ...pastMessages, // Inject the past memory here
            { role: 'user', content: userMessage } // Add the brand new question here
        ];
        
        // --- STEP C: Call Groq ---
        const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
        
        const aiRequest = await fetch(groqUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant', 
                messages: messagesArray // Send the full history array, not just the prompt
            })
        });
        
        const aiData = await aiRequest.json();
        
        if (aiData.error) {
            console.error("AI API Error:", aiData.error);
            return res.status(500).json({ error: 'AI failed' });
        }

        const aiResponse = aiData.choices[0].message.content;

        // --- STEP D: Save the new memory to Firebase ---
        await db.collection('conversations').add({
            user: userMessage,
            ai: aiResponse,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send text back to the mobile app/website
        res.json({ reply: aiResponse });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Alex Server running on port ${port}`));
