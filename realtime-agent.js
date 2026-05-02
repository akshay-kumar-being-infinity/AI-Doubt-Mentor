require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const forumUrl = 'https://forum.mentorpick.com';
const forumCookie = process.env.FORUM_COOKIE;
const apiCookie = process.env.MENTORPICK_API_COOKIE;
const geminiKey = process.env.GEMINI_API_KEY;

// ==========================================
// 1. THE SELF-AWARE TRACKER (Local DB)
// ==========================================
const DB_FILE = path.join(__dirname, 'ai-replies.json');

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
    console.log("📁 Created new ai-replies.json ledger.");
}

function getTrackedPids() {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveTrackedPid(pid) {
    if (!pid) return; // Safety check
    const data = getTrackedPids();
    if (!data.includes(pid)) {
        data.push(pid);
        fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    }
}

// ==========================================
// 2. HARDCODED START TIME (May 2, 2026, 2:12 PM IST)
// ==========================================
// The bot will strictly ignore any topic activity older than this timestamp
const START_TIME_MS = new Date('2026-05-02T14:12:00+05:30').getTime();

// ==========================================
// 3. THE REAL-TIME POLLING ENGINE
// ==========================================
async function pollForum() {
    console.log(`\n[${new Date().toLocaleTimeString()}] 🔄 Scanning for new activity...`);
    
    try {
        const catRes = await axios.get(`${forumUrl}/api/category/5?_=${Date.now()}`, {
            headers: { 'Cookie': forumCookie }
        });
        
        if (!catRes.data.topics) return;
        const recentTopics = catRes.data.topics.slice(0, 15);

        for (const topic of recentTopics) {
            // FILTER 1: Is the topic solved?
            const isSolved = topic.tags && topic.tags.some(tag => tag.value.toLowerCase() === 'solved');
            if (isSolved) continue; 

            // FILTER 2: Is the activity NEWER than our hardcoded start time?
            const lastActivity = topic.lastposttime || topic.timestamp;
            if (lastActivity < START_TIME_MS) {
                continue; // Skip it. It's an old doubt.
            }

            const topicRes = await axios.get(`${forumUrl}/api/topic/${topic.tid}?_=${Date.now()}`, {
                headers: { 'Cookie': forumCookie }
            });
            
            const posts = topicRes.data.posts;
            const lastPost = posts[posts.length - 1]; 
            
            // FILTER 3: The Double-Ledger Check
            // If the newest PID is in our DB (either it's a student we answered, or our own reply), skip!
            const trackedPids = getTrackedPids();
            if (trackedPids.includes(lastPost.pid)) {
                continue; 
            }

            // ==========================================
            // FULL CONVERSATIONAL ENGINE
            // ==========================================
            console.log(`\n🚨 REAL ACTION REQUIRED: Processing Topic ${topic.tid}`);
            
            // 1. Find the Submission Link in the very first post of the thread
            const mainPostContent = posts[0].content;
            const idMatch = mainPostContent.match(/viewSubmission\/([a-f0-9]+)/);
            if (!idMatch) {
                console.log(`   ⏩ No Mentorpick submission link found. Skipping...`);
                saveTrackedPid(lastPost.pid); // Log it so we stop checking it
                continue;
            }
            const submissionId = idMatch[1];

            // 2. Fetch Submission & Problem Data
            const subRes = await axios.get(`https://mentorpick.com/api/submission/${submissionId}`, {
                headers: { 'Cookie': apiCookie }
            });
            const subData = subRes.data.submission;

            let cleanProblemText = "No description available. Infer logic from code.";
            try {
                const problemUrl = `https://mentorpick.com/api/courseV2/problem/html/${subData.problem_id}?contestId=${subData.contest_id}&courseId=${subData.courseV2_id}`;
                const probRes = await axios.get(problemUrl, { headers: { 'Cookie': apiCookie } });
                if (!probRes.data.includes("<title>Error</title>")) {
                    const $ = cheerio.load(probRes.data);
                    cleanProblemText = $.text().replace(/\s+/g, ' ').trim();
                }
            } catch (probError) {}

            let errorHint = subData.verdict_string;
            if (subData.test_results) {
                const failedTest = subData.test_results.find(t => t.verdict !== 'ACCEPTED');
                if (failedTest) errorHint = failedTest.verdict;
            }

            // 3. Build the Chat History Context
            let chatHistory = "";
            posts.forEach((p, index) => {
                let cleanText = p.content.replace(/<[^>]*>?/gm, '').trim();
                chatHistory += `Message ${index + 1}:\n${cleanText}\n\n`;
            });

            // 4. Your Exact Prompt (with history safely appended at the bottom)
            console.log(`   🧠 Waking up Gemini to analyze code...`);
            const prompt = `You are a brilliant, empathetic Senior Developer mentoring a junior developer on a coding forum.

FIRST, analyze the VERY LAST message in the "THREAD HISTORY" below to determine the student's intent. 

=========================================
IF THE STUDENT IS SAYING THANKS OR IT WORKED:
Respond warmly in exactly 1 sentence. Express that you are glad to help, and politely ask them to "Please mark this doubt as 'Solved' on the platform so we know you are good to go! Happy coding." 
(DO NOT give any further coding hints in this scenario).
=========================================

=========================================
IF THE STUDENT IS STILL STUCK, ASKING A FOLLOW-UP, OR IT IS A NEW POST:
Provide a hint by following these CRITICAL RULES:
1. STRICT LENGTH LIMIT: Your entire response MUST be 1 to 2 sentences max. Keep it punchy and readable.
2. ENCOURAGING START: Begin with a brief, warm pleasantry to build their confidence (e.g., "Hey there, you're super close!", "Great overall structure!", "Nice job on the logic so far!").
3. BE DYNAMIC: Choose ONE of these five mentoring styles that best fits the specific error in their code:
   - The Edge Case: Give a tiny, specific test case where their logic breaks (e.g., "Walk through your loop manually if N = 0; what does index i-1 evaluate to?").
   - The Socratic Question: Point to a specific line and ask a leading question (e.g., "If your accumulator exceeds 2 billion during the sum, what happens to your 'int' data type?").
   - The Goal Checker: Point out a mismatch between their code and the prompt (e.g., "Your code perfectly calculates the total sum, but double-check the problem—it's actually asking for the maximum contiguous sum.").
   - The Scope Restrictor: Tell them exactly where to look without explaining the bug itself (e.g., "Your overall BFS is solid, but take a very close look at the boundary conditions inside your inner while-loop.").
   - The Real-World Analogy: Use a quick analogy for abstract logic (e.g., "Think of your queue like a line at a coffee shop; right now, your code is accidentally letting people cut to the front.").
4. NO DIRECT CODE FIXES: Do not write the corrected code snippet or give the exact answer. Let them have the "aha!" moment.
5. PLAIN TEXT FORMATTING ONLY: Absolutely NO LaTeX, Markdown math, or special symbols (do NOT use $x$, $N$, $$ etc.). Write variables naturally as plain text (e.g., "variable x", "array N", "O(N)").
=========================================

Problem Context:
---
${cleanProblemText}
---

Their ${subData.language} code:
---
${subData.userCode}
---

The system error: ${errorHint}

--- THREAD HISTORY (For Context) ---
${chatHistory}

Write your response now based on the final message in the Thread History.`;

            // 5. Call Gemini
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
                    if (err.response && err.response.status === 503) {
                        if (attempt === 3) throw new Error("Gemini API overloaded.");
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    } else throw err;
                }
            }

            // 6. Post Reply to Forum
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
                
                // YOUR BRILLIANT FIX: Save the student's PID *and* the AI's newly generated PID
                saveTrackedPid(lastPost.pid); 
                if (replyRes.data && replyRes.data.response && replyRes.data.response.pid) {
                    saveTrackedPid(replyRes.data.response.pid);
                }
                
            } else {
                console.log(`   ⚠️ Forum rejected the post. Status: ${replyRes.status}`);
            }

            // Wait 5 seconds between answering doubts to respect rate limits
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

    } catch (error) {
        console.error("❌ Polling Error:", error.message);
    }
}

// ==========================================
// 4. START THE ASYNC ENGINE
// ==========================================
async function runBot() {
    console.log("🚀 Starting Real-Time Conversational Agent (Filtering data prior to May 2, 2:12 PM)...");
    
    while (true) {
        await pollForum();
        console.log(`\n⏳ Batch complete. Sleeping for 60 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

runBot();