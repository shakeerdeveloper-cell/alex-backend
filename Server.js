require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

// Bypass CORS Security Restrictions
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Initialize Firebase safely
let db = null;
try {
    const serviceAccount = require('./firebase-key.json');
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
    db = admin.firestore();
    console.log("Firebase initialized successfully.");
} catch (e) {
    console.error("Firebase Init Warning:", e.message);
}

// Core Chat Route
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        if (!userMessage) {
            return res.json({ reply: "Please provide a valid text message." });
        }

        if (!process.env.GROQ_API_KEY) {
            return res.json({ reply: "Backend Error: GROQ_API_KEY environment variable is missing on Render." });
        }

        // Fetch past conversation memory from Firebase if available
        let pastMessages = [];
        if (db) {
            try {
                const historySnapshot = await db.collection('conversations')
                    .orderBy('timestamp', 'desc')
                    .limit(10)
                    .get();

                historySnapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.user && data.ai) {
                        pastMessages.unshift({ role: 'assistant', content: data.ai });
                        pastMessages.unshift({ role: 'user', content: data.user });
                    }
                });
            } catch (dbErr) {
                console.error("Firestore Memory Read Error:", dbErr.message);
            }
        }

        const systemPrompt = "You are Alex, a helpful, natural, and friendly AI assistant. Keep responses warm and concise (1 to 3 sentences).";

        const messagesArray = [
            { role: 'system', content: systemPrompt },
            ...pastMessages,
            { role: 'user', content: userMessage }
        ];

        // Call Groq API
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`
            },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                messages: messagesArray
            })
        });

        const groqData = await groqResponse.json();

        if (groqData.error) {
            console.error("Groq API Error:", groqData.error);
            return res.json({ reply: `Groq Error: ${groqData.error.message || 'Failed to generate response'}` });
        }

        if (!groqData.choices || !groqData.choices[0] || !groqData.choices[0].message) {
            return res.json({ reply: "Error: Received invalid data format from the AI model." });
        }

        const aiReply = groqData.choices[0].message.content;

        // Save new message to Firebase
        if (db) {
            try {
                await db.collection('conversations').add({
                    user: userMessage,
                    ai: aiReply,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (saveErr) {
                console.error("Firestore Save Error:", saveErr.message);
            }
        }

        return res.json({ reply: aiReply });

    } catch (error) {
        console.error("Server Catch Error:", error);
        return res.json({ reply: `Server Error: ${error.message}` });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Alex Server running on port ${port}`));
