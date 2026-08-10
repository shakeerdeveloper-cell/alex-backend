require('dotenv').config();
const express = require('express');
const admin = require('firebase-admin');
const { tavily } = require('@tavily/core');

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

        if (!userMessage) return res.json({ reply: "Please provide a valid text message." });
        if (!process.env.GROQ_API_KEY) return res.json({ reply: "Backend Error: GROQ_API_KEY is missing on Render." });
        if (!process.env.TAVILY_API_KEY) return res.json({ reply: "Backend Error: TAVILY_API_KEY is missing on Render." });

        const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

        // Fetch past conversation memory (Clean messages only)
        let pastMessages = [];
        if (db) {
            try {
                const historySnapshot = await db.collection('conversations')
                    .orderBy('timestamp', 'desc')
                    .limit(6)
                    .get();

                let docs = [];
                historySnapshot.forEach(doc => docs.push(doc.data()));
                docs.reverse(); // Oldest first

                docs.forEach(data => {
                    if (data.user && data.ai && !data.ai.includes("Error:") && !data.ai.includes("Groq Error")) {
                        pastMessages.push({ role: 'user', content: data.user });
                        pastMessages.push({ role: 'assistant', content: data.ai });
                    }
                });
            } catch (dbErr) {
                console.error("Firestore Memory Read Error:", dbErr.message);
            }
        }

        const systemPrompt = "You are Alex, an intelligent, helpful, and friendly AI assistant. If the user asks for real-time information, current events, recent news, sports scores, weather, or facts beyond your training data, YOU MUST use the 'search_web' tool to find the live answer. Keep responses conversational and concise.";

        let messagesArray = [
            { role: 'system', content: systemPrompt },
            ...pastMessages,
            { role: 'user', content: userMessage }
        ];

        // Define the Internet Browser Tool
        const tools = [{
            type: "function",
            function: {
                name: "search_web",
                description: "Search the live internet for real-time news, sports, weather, and current events.",
                parameters: {
                    type: "object",
                    properties: { 
                        query: { 
                            type: "string", 
                            description: "The Google search query." 
                        } 
                    },
                    required: ["query"]
                }
            }
        }];

        const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
        const groqModel = 'llama-3.3-70b-versatile'; // Upgraded to a much smarter, larger model

        // Step 1: Ask AI if it needs to search the web
        let aiRequest = await fetch(groqUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`
            },
            body: JSON.stringify({
                model: groqModel,
                messages: messagesArray,
                tools: tools,
                tool_choice: "auto"
            })
        });

        let aiData = await aiRequest.json();
        if (aiData.error) return res.json({ reply: `Groq Error: ${aiData.error.message}` });

        let responseMessage = aiData.choices[0].message;
        let aiReply = "";

        // Step 2: Handle Internet Search if the AI decided to browse
        if (responseMessage.tool_calls) {
            console.log("ALEX IS SEARCHING THE LIVE WEB!");
            messagesArray.push(responseMessage); // Add AI's decision to memory
            
            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "search_web") {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log("Query:", args.query);
                    
                    try {
                        const searchData = await tvly.search(args.query);
                        const webContext = searchData.results.map(r => r.content).join('\n');
                        messagesArray.push({ 
                            role: "tool", 
                            tool_call_id: toolCall.id, 
                            name: toolCall.function.name, 
                            content: webContext 
                        });
                    } catch (searchErr) {
                        messagesArray.push({ 
                            role: "tool", 
                            tool_call_id: toolCall.id, 
                            name: toolCall.function.name, 
                            content: "Internet search failed." 
                        });
                    }
                }
            }

            // Step 3: Second AI call to read the internet results and give you the answer
            let secondAiRequest = await fetch(groqUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY.trim()}`
                },
                body: JSON.stringify({
                    model: groqModel,
                    messages: messagesArray
                })
            });
            
            let secondAiData = await secondAiRequest.json();
            aiReply = secondAiData.choices[0].message.content;

        } else {
            // AI decided it didn't need the internet (e.g., natural conversation)
            aiReply = responseMessage.content;
        }

        // Save new clean message pair to Firebase
        if (db) {
            try {
                await db.collection('conversations').add({
                    user: userMessage,
                    ai: aiReply,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            } catch (saveErr) {}
        }

        return res.json({ reply: aiReply });

    } catch (error) {
        console.error("Server Catch Error:", error);
        return res.json({ reply: `Server Error: ${error.message}` });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Alex Server running on port ${port}`));
