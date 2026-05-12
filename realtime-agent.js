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
// 1.5 THE TOPIC STATE CACHE (RAM)
// ==========================================
// This remembers the last time we checked a topic so we don't fetch it twice
const topicCache = {}; 

// ==========================================
// 2. HARDCODED START TIME
// ==========================================
// The bot will strictly ignore any topic activity older than this timestamp
const START_TIME_MS = new Date('2026-05-12T16:14:40+05:30').getTime();

// ==========================================
// 3. THE REAL-TIME POLLING ENGINE
// ==========================================
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
            
            if (!catRes.data.topics || catRes.data.topics.length === 0) {
                break; // No more topics, stop scanning
            }

            for (const topic of catRes.data.topics) {
                const lastActivity = topic.lastposttime || topic.timestamp;
                
                // If we hit a topic older than our hardcoded start time, we can stop scanning older pages!
                if (lastActivity < START_TIME_MS) {
                    keepScanning = false; 
                    continue; 
                }
                
                allRecentTopics.push(topic);
            }
            page++;
        }

        console.log(`   🎯 Found ${allRecentTopics.length} active topics since the cutoff time.`);

        // Now process every single topic we found
        for (const topic of allRecentTopics) {
            // FILTER 1: Is the topic solved?
            const isSolved = topic.tags && topic.tags.some(tag => tag.value.toLowerCase() === 'solved');
            if (isSolved) continue; 

            const lastActivity = topic.lastposttime || topic.timestamp;

            // ==========================================
            // THE BRILLIANT CACHE FILTER
            // ==========================================
            // If we have seen this topic before, and its last activity time is exactly the same, 
            // it means nobody has replied since we last checked. Skip it instantly!
            if (topicCache[topic.tid] === lastActivity) {
                continue; 
            }

            // We are about to check this topic. Save its activity time to our cache.
            topicCache[topic.tid] = lastActivity;

            // ... Now we make the heavy API call, because we know something changed!
            const topicRes = await axios.get(`${forumUrl}/api/topic/${topic.tid}?_=${Date.now()}`, {
                headers: { 'Cookie': forumCookie }
            });
            
            const posts = topicRes.data.posts;
            const lastPost = posts[posts.length - 1]; 
            
            // FILTER 2: Only reply if the last message is from the student
            if (lastPost.user && lastPost.user.username !== 'mp-nbb-bot') {
                continue; 
            }
            
            // FILTER 3: The Double-Ledger Check
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
                saveTrackedPid(lastPost.pid);
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

            // 4. Your Exact Prompt
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
                    const status = err.response ? err.response.status : null;
                    if (status === 429 || status === 503) {
                        console.log(`   ⚠️ Gemini API Limit hit (${status}). Pausing for 15 seconds... (Attempt ${attempt}/3)`);
                        if (attempt === 3) throw new Error(`Gemini API Failed after 3 retries. Status: ${status}`);
                        await new Promise(resolve => setTimeout(resolve, 8000));
                    } else {
                        throw err; 
                    }
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
                saveTrackedPid(lastPost.pid); 
                if (replyRes.data && replyRes.data.response && replyRes.data.response.pid) {
                    saveTrackedPid(replyRes.data.response.pid);
                }
            } else {
                console.log(`   ⚠️ Forum rejected the post. Status: ${replyRes.status}`);
            }

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
    console.log("🚀 Starting Real-Time Conversational Agent...");
    
    while (true) {
        await pollForum();
        console.log(`\n⏳ Batch complete. Sleeping for 60 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

runBot();