require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const forumUrl = 'https://forum.mentorpick.com';
const forumCookie = process.env.FORUM_COOKIE;
const apiCookie = process.env.MENTORPICK_API_COOKIE;
const geminiKey = process.env.GEMINI_API_KEY;

// 1. THE SELF-AWARE TRACKER (Local DB)
const DB_FILE = path.join(__dirname, 'ai-replies.json');

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
    console.log("📁 Created new ai-replies.json ledger.");
}

function getTrackedPids() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveTrackedPid(pid) {
    if (!pid) return; 
    const data = getTrackedPids();
    if (!data.includes(pid)) {
        data.push(pid);
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    }
}

// 1.5 THE TOPIC STATE CACHE (RAM)
const topicCache = {}; 

// 2. HARDCODED START TIME
const START_TIME_MS = new Date('2026-05-13T10:45:40+05:30').getTime();

// 3. THE REAL-TIME POLLING ENGINE
async function pollForum() {
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔄 Scanning for new activity...`);
    
    try {
        let allRecentTopics = [];
        let page = 1;
        let keepScanning = true;

        while (keepScanning) {
            console.log(`   📄 Fetching page ${page} of the forum...`);
            const catRes = await axios.get(`${forumUrl}/api/category/5?page=${page}&_=${Date.now()}`, {
                headers: { 'Cookie': forumCookie }
            });
            
            if (!catRes.data.topics || catRes.data.topics.length === 0) break; 

            for (const topic of catRes.data.topics) {
                const lastActivity = topic.lastposttime || topic.timestamp;
                if (lastActivity < START_TIME_MS) {
                    keepScanning = false; 
                    continue; 
                }
                allRecentTopics.push(topic);
            }
            page++;
        }

        console.log(`   🎯 Found ${allRecentTopics.length} active topics since the cutoff time.`);

        for (const topic of allRecentTopics) {
            const isSolved = topic.tags && topic.tags.some(tag => tag.value.toLowerCase() === 'solved');
            if (isSolved) continue; 

            const lastActivity = topic.lastposttime || topic.timestamp;

            if (topicCache[topic.tid] === lastActivity) continue; 
            topicCache[topic.tid] = lastActivity;

            const topicRes = await axios.get(`${forumUrl}/api/topic/${topic.tid}?_=${Date.now()}`, {
                headers: { 'Cookie': forumCookie }
            });
            
            const posts = topicRes.data.posts;
            const lastPost = posts[posts.length - 1]; 
            
            if (lastPost.user && lastPost.user.username !== 'mp-nbb-bot') continue; 
            
            // FILTER 3: The Double-Ledger Check
            const trackedPids = getTrackedPids();
            if (trackedPids.includes(lastPost.pid)) continue; 

            // FULL CONVERSATIONAL ENGINE
            console.log(`\n🚨 REAL ACTION REQUIRED: Processing Topic ${topic.tid}`);
            
            // 1. Find the Submission Link in the very first post of the thread
            const mainPostContent = posts[0].content;
            const idMatch = mainPostContent.match(/viewSubmission\/([a-f0-9]+)/);
            if (!idMatch) {
                console.log(`   ⏩ No Mentorpick submission link found. Skipping...`);
                saveTrackedPid(lastPost.pid);
                continue;
            }
            const submissionId = idMatch[1];

            // 2. Fetch Submission & Problem Data
            const subRes = await axios.get(`https://mentorpick.com/api/submission/${submissionId}`, {
                headers: { 'Cookie': apiCookie }
            });
            const subData = subRes.data.submission;

            // EXTRACT STUDENT NAME 
            let studentName = null; 
            
            if (subData.user && subData.user.firstName) {
                studentName = subData.user.firstName;
            } else if (subData.user && subData.user.name) {
                studentName = subData.user.name;
            }

            let cleanProblemText = "No description available. Infer logic from code.";
            try {
                const problemUrl = `https://mentorpick.com/api/courseV2/problem/html/${subData.problem_id}?contestId=${subData.contest_id}&courseId=${subData.courseV2_id}`;
                const probRes = await axios.get(problemUrl, { headers: { 'Cookie': apiCookie } });
                if (!probRes.data.includes("<title>Error</title>")) {
                    const $ = cheerio.load(probRes.data);
                    cleanProblemText = $.text().replace(/\s+/g, ' ').trim();
                }
            } catch (probError) {}

            // EXTRACT DETAILED ERRORS
            let errorHint = subData.verdict_string || "Unknown Error"; 
            if (subData.compilation_errors) {
                errorHint += `\nDetailed Logs:\n${subData.compilation_errors}`;
            } else if (subData.test_results) {
                const failedTest = subData.test_results.find(t => t.verdict !== 'ACCEPTED');
                if (failedTest) errorHint = failedTest.verdict;
            }

            let chatHistory = "";
            posts.forEach((p, index) => {
                let cleanText = p.content.replace(/<[^>]*>?/gm, '').trim();
                let speaker = (p.user && p.user.username === 'mp-nbb-bot') ? "Student" : "Mentor";
                chatHistory += `${speaker} (Message ${index + 1}):\n${cleanText}\n\n`;
            });

            console.log(`   🧠 Waking up Gemini to analyze code...`);
            
            // UPGRADED PROMPT
            const prompt = `You are a brilliant, empathetic mentor who resolves coding doubts posted by students. You are a real human; NEVER reveal you are an AI.

STUDENT NAME: ${studentName ? studentName : "Not available"}
PROBLEM CONTEXT: ${cleanProblemText}
SYSTEM ERROR: ${errorHint}
FAULTY CODE:
${subData.userCode}

--- THREAD HISTORY ---
${chatHistory}
----------------------

INSTRUCTIONS:
Read the Thread History. Pay extremely close attention to the VERY LAST message from the "Student". Decide which scenario applies:

SCENARIO A: The student is just saying thanks or confirming it worked.
- Respond in 1 sentence asking them to "Please mark this doubt as 'Solved' on the platform! Happy coding."

SCENARIO B: The student is asking a specific FOLLOW-UP question.
- CRITICAL: DO NOT repeat your previous hints.
- Directly answer the specific question they just asked in their last message.
- If they ask for exact code, politely refuse and explain the logic instead.
- Gradually escalate the hint: If they are still stuck after a previous hint, give them a more specific clue (e.g., mention the exact line number or variable causing the problem).
- IDENTITY RULE: If they ask "Who are you?" or ask about your background, simply state you are a mentor here to help resolve student doubts. Do NOT mention "forums."
- DO NOT greet them again. Jump straight into answering their question.

SCENARIO C: This is a BRAND NEW doubt.
- Greet them naturally (e.g., "Hey ${studentName ? studentName : 'there'}, let's look at this!").
- Give a high-level conceptual hint based on the system error and their code. 

GLOBAL RULES FOR ALL REPLIES:
1. SAFE FORMATTING: You MAY use standard Markdown for code formatting. Use backticks for variable names/short snippets (e.g., \`int x = 0;\`). Use **bolding** for emphasis. You must ABSOLUTELY AVOID LaTeX, Markdown math, or special math symbols ($x$, $$, \\( \\)) as they will break the forum UI.
2. LENGTH LIMIT: Keep it punchy. Maximum 1 to 3 short sentences.
3. NO SPOILERS: Never write the corrected code snippet. Guide them to the "aha!" moment.`;

            const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${geminiKey}`;
            let aiResponseText = "";
            
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    const geminiResponse = await axios.post(geminiUrl, {
                        contents: [{ parts: [{ text: prompt }] }]
                    }, { headers: { 'Content-Type': 'application/json' } });
                    aiResponseText = geminiResponse.data.candidates[0].content.parts[0].text;
                    break;
                } catch (err) {
                    const status = err.response ? err.response.status : null;
                    if (status === 429 || status === 503) {
                        console.log(`   ⚠️ Gemini API Limit hit (${status}). Pausing for 15 seconds... (Attempt ${attempt}/3)`);
                        if (attempt === 3) throw new Error(`Gemini API Failed after 3 retries. Status: ${status}`);
                        await new Promise(resolve => setTimeout(resolve, 15000)); // Fixed: 15s penalty for rate limits
                    } else {
                        throw err; 
                    }
                }
            }

            console.log("   📝 Posting live reply to forum...");
            const configRes = await axios.get(`${forumUrl}/api/config`, { headers: { 'Cookie': forumCookie } });
            const csrfToken = configRes.data.csrf_token;

            const replyRes = await axios.post(
                `${forumUrl}/api/v3/topics/${topic.tid}`, 
                { content: aiResponseText },
                {
                    headers: {
                        'Cookie': forumCookie,
                        'x-csrf-token': csrfToken,
                        'Content-Type': 'application/json'
                    },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status < 400
                }
            );

            if (replyRes.status === 200) {
                console.log(`   ✅ Success! Reply posted.`);
                saveTrackedPid(lastPost.pid); 
                if (replyRes.data && replyRes.data.response && replyRes.data.response.pid) {
                    saveTrackedPid(replyRes.data.response.pid);
                }
            } else {
                console.log(`   ⚠️ Forum rejected the post. Status: ${replyRes.status}`);
            }

            await new Promise(resolve => setTimeout(resolve, 8000)); // Fixed: 8s delay for our safe SLA speed
        }

    } catch (error) {
        console.error("❌ Polling Error:", error.message);
    }
}

// 4. START THE ASYNC ENGINE
async function runBot() {
    console.log("🚀 Starting Real-Time Conversational Agent...");
    
    while (true) {
        await pollForum();
        console.log(`\n⏳ Batch complete. Sleeping for 60 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

runBot();