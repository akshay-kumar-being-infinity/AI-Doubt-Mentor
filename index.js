require('dotenv').config();
const axios = require('axios');

async function fetchCodeDirectly() {
    const apiUrl = 'https://mentorpick.com/api/submission/69f351ea05e8ffefa17f04c3'; 
    const apiCookie = process.env.MENTORPICK_API_COOKIE; 

    try {
        console.log("🚀 Fetching code using the exact browser cookies...");
        
        const response = await axios.get(apiUrl, {
            headers: {
                'Cookie': apiCookie, 
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const data = response.data;

        if (data.status === true && data.submission) {
            console.log("\n✅ SUCCESS! We cracked the API.");
            console.log(`Verdict: ${data.submission.verdict_string}`);
            
            if (data.submission.test_results) {
                 const failedTests = data.submission.test_results.filter(t => t.verdict !== 'ACCEPTED');
                 if (failedTests.length > 0) {
                     console.log(`Failed Test Error: ${failedTests[0].verdict}`);
                 }
            }

            console.log("\n--- Extracted Java Code ---");
            console.log(data.submission.userCode);
            console.log("---------------------------");
            
        }

    } catch (error) {
        console.error("❌ Request failed:", error.message);
    }
}

fetchCodeDirectly();