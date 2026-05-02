require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');

const forumUrl = 'https://forum.mentorpick.com';
const forumCookie = process.env.FORUM_COOKIE;
const apiCookie = process.env.MENTORPICK_API_COOKIE;
const geminiKey = process.env.GEMINI_API_KEY;

async function runMasterBot() {
    try {
        console.log("🤖 1. Scanning 'Ask Doubt' Category for Unanswered Topics...");
        
        // Cache-busting URL so we don't fetch topics we just answered!
        const categoryRes = await axios.get(`${forumUrl}/api/category/5?_=${Date.now()}`, {
            headers: { 'Cookie': forumCookie }
        });
        
        if (!categoryRes.data.topics || categoryRes.data.topics.length === 0) {
            console.log("🛑 No topics found in this category.");
            return;
        }

        const unansweredTopics = categoryRes.data.topics
            .filter(topic => topic.postcount === 1 || topic.replies === 0)
            .slice(0, 5);

        if (unansweredTopics.length === 0) {
            console.log("✅ All caught up! No unanswered doubts found.");
            return;
        }

        console.log(`🎯 Found ${unansweredTopics.length} unanswered doubts. Starting batch process...\n`);

        for (let i = 0; i < unansweredTopics.length; i++) {
            const topic = unansweredTopics[i];
            const tid = topic.tid;
            
            console.log(`--------------------------------------------------`);
            console.log(`🔍 Processing Topic ${i + 1}/${unansweredTopics.length} (TID: ${tid} | Author: ${topic.user.username})`);

            try {
                const topicRes = await axios.get(`${forumUrl}/api/topic/${tid}?_=${Date.now()}`, {
                    headers: { 'Cookie': forumCookie }
                });
                const mainPostContent = topicRes.data.posts[0].content;
                
                const idMatch = mainPostContent.match(/viewSubmission\/([a-f0-9]+)/);
                if (!idMatch) {
                    console.log(`⏩ No Mentorpick submission link found. Skipping...`);
                    continue;
                }
                const submissionId = idMatch[1];

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

                // ==========================================
                // THE "SNIPER HINT" PROMPT
                // ==========================================
                console.log(`🧠 Waking up Gemini to analyze error: ${errorHint}...`);
                const prompt = `
You are a brilliant, empathetic Senior Developer looking over a junior's code. You spot the bug immediately, offer a quick word of encouragement, and drop a powerful hint before letting them solve it.

CRITICAL RULES:
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

Problem Context:
---
${cleanProblemText}
---

Their ${subData.language} code:
---
${subData.userCode}
---

The system error: ${errorHint}

Write your encouraging, dynamic hint now.
`;

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

                console.log("📝 Posting reply to forum...");
                const configRes = await axios.get(`${forumUrl}/api/config`, { headers: { 'Cookie': forumCookie } });
                const csrfToken = configRes.data.csrf_token;

                const replyRes = await axios.post(
                    `${forumUrl}/api/v3/topics/${tid}`, 
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
                    console.log(`✅ Success! Reply posted to: ${forumUrl}/topic/${tid}`);
                } else {
                    console.log(`⚠️ Forum rejected the post. Status: ${replyRes.status}`);
                }

            } catch (err) {
                console.error(`❌ Error processing topic ${tid}:`, err.message);
            }

            if (i < unansweredTopics.length - 1) {
                console.log(`⏳ Waiting 5 seconds before processing the next doubt...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        console.log(`\n🎉 Batch processing complete!`);

    } catch (error) {
        console.error("\n❌ Fatal Error:", error.message);
    }
}

runMasterBot();