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

// 1. Initialize Firebase & Web Search
const serviceAccount = require('./firebase-key.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

// 2. The Core Chat Endpoint (Function Calling / Tool Use)
app.post('/chat', async (req, res) => {
    try {
        const userMessage = req.body.message;

        // --- STEP A: Fetch Memory ---
        const historySnapshot = await db.collection('conversations')
            .orderBy('timestamp', 'desc')
            .limit(10) 
            .get();

        let pastMessages = [];
        historySnapshot.forEach(doc => {
            const data = doc.data();
            pastMessages.unshift({ role: 'assistant', content: data.ai });
            pastMessages.unshift({ role: 'user', content: data.user });
        });

        // --- STEP B: The Human Personality Prompt ---
        const systemPrompt = `You are Alex, a highly natural, conversational, and friendly human-like AI assistant. 
        Speak casually, using natural conversational phrasing with high empathy. Do not sound robotic. 
        You act as a creative partner, always ready to brainstorm ideas for projects like 9:16 portrait animations, educational alphabet designs, or structured outfit modeling sequences.
        Keep responses to 1 to 3 short, spoken sentences. 
        CRITICAL RULE: If the user asks for facts, news, weather, or specific information you do not know, YOU MUST USE THE 'search_web' TOOL. If they are just chatting or sharing feelings, DO NOT use the tool.`;

        let messagesArray = [
            { role: 'system', content: systemPrompt },
            ...pastMessages,
            { role: 'user', content: userMessage }
        ];

        // --- STEP C: Define the Browser Tool for the AI ---
        const tools = [
            {
                type: "function",
                function: {
                    name: "search_web",
                    description: "Search the live internet for factual answers, news, weather, or current events.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: {
                                type: "string",
                                description: "The exact search query to look up on the internet."
                            }
                        },
                        required: ["query"]
                    }
                }
            }
        ];
        
        const groqUrl = 'https://api.groq.com/openai/v1/chat/completions';
        
        // --- STEP D: First AI Request (Let Alex decide what to do) ---
        let aiRequest = await fetch(groqUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant', 
                messages: messagesArray,
                tools: tools,
                tool_choice: "auto" // This allows the AI to choose whether to search or not
            })
        });
        
        let aiData = await aiRequest.json();
        if (aiData.error) throw new Error(aiData.error.message);

        let responseMessage = aiData.choices[0].message;
        let aiResponse = "";

        // --- STEP E: Check if Alex decided to use the Browser Tool ---
        if (responseMessage.tool_calls) {
            console.log("ALEX DECIDED TO SEARCH THE WEB!");
            
            // Log Alex's request into the memory chain
            messagesArray.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === "search_web") {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log("Searching for:", args.query);
                    
                    // Actually search the internet
                    const searchData = await tvly.search(args.query);
                    const webContext = searchData.results.map(r => r.content).join('\n');

                    // Give the internet results back to Alex
                    messagesArray.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        name: toolCall.function.name,
                        content: webContext
                    });
                }
            }

            // --- STEP F: Second AI Request (Alex reads results and speaks) ---
            let secondAiRequest = await fetch(groqUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant', 
                    messages: messagesArray
                })
            });
            
            let secondAiData = await secondAiRequest.json();
            aiResponse = secondAiData.choices[0].message.content;

        } else {
            // --- STEP G: Alex decided to just have a human conversation ---
            console.log("ALEX DECIDED TO JUST CHAT NATURALLY.");
            aiResponse = responseMessage.content;
        }

        // --- STEP H: Save to Database ---
        await db.collection('conversations').add({
            user: userMessage,
            ai: aiResponse,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ reply: aiResponse });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: 'Failed to process request' });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Alex Server running on port ${port}`));
