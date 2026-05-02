# AI-Doubt-Mentor 🤖

An autonomous, context-aware conversational AI agent built for the Mentorpick coding forum. Powered by Node.js and Google's Gemini 1.5 Flash, this bot acts as an empathetic Mentor, providing real-time, highly targeted hints to students stuck on coding problems.

---

## 🌟 Key Features

- **Real-Time Async Polling:** Continuously scans the "Ask Doubt" forum category for new questions or follow-up replies without overlapping API calls.

- **Stateful Conversation Tracking:** Uses a local JSON ledger (`ai-replies.json`) to track processed Post IDs (`pid`). Prevents duplicate replies and avoids the bot replying to itself.

- **Smart Intent Routing:**
  - *Stuck / Follow-up:* Gives a sharp 1–2 line hint  
  - *Gratitude ("Thanks", "It worked"):* Asks user to mark problem as solved  

- **Dynamic Mentoring Styles:**
  1. Edge Case  
  2. Socratic Question  
  3. Goal Checker  
  4. Scope Restrictor  
  5. Real-World Analogy  

- **No Spoilers Policy:** Never provides full solutions — only hints

- **Plain-Text Safe:** Avoids LaTeX formatting issues

---

## 🏗 Architecture

1. **Scraper** – Fetches latest topics from NodeBB API  
2. **Filter** – Removes solved/old/already-processed posts  
3. **Context Builder** – Gathers code, problem, and thread history  
4. **AI Engine** – Sends context to Gemini with strict persona rules  
5. **Poster** – Posts reply and updates `ai-replies.json`  

---

## 🚀 Setup & Usage

### Install Dependencies

```bash
npm install