# AI-Doubt-Mentor 🤖

An autonomous, context-aware conversational AI agent built for the Mentorpick coding forum. Powered by Node.js and Google's Gemini 1.5 Flash, this bot acts as a human-like Senior Mentor, providing real-time, highly targeted hints to students stuck on coding problems.

---

## 🌟 Key Features

* **Targeted Rollouts (Canary Release):** Configure specific tags (e.g., `dsa`, `arrays`) via `.env` to restrict the bot to specific topics, or leave it blank to resolve all doubts platform-wide.
* **Human Mentor Collision Avoidance:** Automatically detects if a human mentor has jumped into a thread and silently backs off to prevent stepping on their toes.
* **Smart Intent Routing & Context Escalation:**
    * *Brand New Doubt:* Greet and provides a high-level conceptual hint.
    * *Follow-Up Question:* Escalates the hint complexity (e.g., pointing to specific line numbers) without repeating previous greetings or hints.
    * *Gratitude ("Thanks", "It worked"):* Skips analysis and politely asks the user to mark the problem as 'Solved'.
* **No Spoilers Policy:** Strict prompt guardrails prevent the AI from writing the corrected code snippet, guiding students to the "aha!" moment instead.
* **High-Performance Memory System:**
    * *Short-Term RAM Cache:* Memorizes topic states to eliminate N+1 API query spam, bypassing unchanged topics in milliseconds.
    * *Long-Term Ledger:* Uses a local JSON ledger (`ai-replies.json`) to track processed Post IDs (`pid`), preventing duplicate replies and infinite loops.
* **Enterprise Resilience:** Features 5-page deep pagination to prevent "starvation" of older doubts, an 8-second pacing delay to guarantee a 10-minute SLA safely, and 15-second exponential backoffs to handle API rate limits gracefully.

---

## 🏗 Architecture Workflow

1. **The Radar Sweep:** Scans up to 5 pages of the forum to build a queue of active topics.
2. **The Gauntlet (Filtration):** Instantly drops topics that are marked "Solved", don't match `TARGET_TAGS`, haven't changed since the last RAM cache check, or have been claimed by a human mentor.
3. **Context Aggregation:** Securely scrapes the Mentorpick API to extract the problem constraints, the student's exact faulty code, and detailed compilation/test errors.
4. **AI Engine:** Feeds the formatted thread history and code context to Gemini, utilizing a strict Socratic persona.
5. **The Executor:** Posts the plain-text safe formatted reply back to the forum UI and updates the local ledger.

---

## 🚀 Setup & Usage

### 1. Install Dependencies

```bash
npm install axios cheerio dotenv