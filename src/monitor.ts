import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { chromium } from "playwright";

const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN || "";
const REGION = process.env.AWS_REGION || "us-east-1";
const INTERVAL = 30 * 60 * 1000 + Math.random() * 5 * 60 * 1000; // 30 min + 0-5 min jitter
const DAILY_REPORT_HOUR = 7; // Send daily report at 7 AM UTC (adjust as needed)

const snsClient = new SNSClient({ region: REGION });

async function sendNotification(subject: string, message: string) {
    const params = {
        Subject: subject,
        Message: message,
        TopicArn: SNS_TOPIC_ARN,
    };

    try {
        await snsClient.send(new PublishCommand(params));
        console.log(`📧 SNS Notification Sent: ${subject}`);
    } catch (err) {
        console.error("❌ Error sending SNS notification:", err);
    }
}

// ✅ Function to check if a date is a **future** Saturday or Sunday
function isFutureWeekend(dateStr: string): boolean {
    const today = new Date();
    const date = new Date(dateStr);
    return date > today && (date.getDay() === 6 || date.getDay() === 0); // 6 = Saturday, 0 = Sunday
}

// ✅ Function to send the daily parking report
async function sendDailyReport(availability: Record<string, boolean>) {
    const report: string[] = ["📊 **Daily Parking Availability Report**"];

    for (const [date, available] of Object.entries(availability)) {
        report.push(`📅 ${date} - Available: ${available ? "✅ Yes" : "❌ No"}`);
    }

    await sendNotification("📊 Daily Parking Report", report.join("\n"));
}

// ✅ Function to schedule the daily report at a fixed time
function scheduleDailyReport(previousAvailability: Record<string, boolean>) {
    const now = new Date();
    const nextRun = new Date();
    nextRun.setUTCHours(DAILY_REPORT_HOUR, 0, 0, 0);

    // If the scheduled time has already passed today, set it for tomorrow
    if (now > nextRun) {
        nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    }

    const delay = nextRun.getTime() - now.getTime();
    console.log(`⏳ Scheduling next daily report in ${Math.round(delay / 1000 / 60)} minutes`);

    setTimeout(async () => {
        await sendDailyReport(previousAvailability);
        scheduleDailyReport(previousAvailability); // Schedule next day's report
    }, delay);
}

const scrapeParkingAvailability = async () => {
    console.log("🚀 Launching browser...");
    await sendNotification("🚀 Parking Monitor Started", "The parking availability monitor has started successfully and is now tracking updates.");

    const browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/120.0.0.0",
    });

    const page = await context.newPage();
    console.log("🌍 Navigating to parking page...");
    await page.goto("https://reservenski.parkstevenspass.com/select-parking", { waitUntil: "domcontentloaded" });

    console.log("📡 Setting up network listener...");
    let previousAvailability: Record<string, boolean> = {};

    page.on("response", async (response) => {
        if (!response.url().includes("graphql")) return;

        try {
            const json = await response.json();
            if (json?.data?.publicParkingAvailability) {
                const newAvailability: Record<string, boolean> = {};
                let startupReport: string[] = ["📊 **Current Weekend Parking Availability:**"];

                for (const [date, details] of Object.entries(json.data.publicParkingAvailability)) {
                    if (!isFutureWeekend(date)) continue; // Skip past dates & weekdays

                    let soldOut = false;

                    if (typeof details === "object" && details !== null && "status" in details) {
                        soldOut = (details as { status: { sold_out: boolean } }).status.sold_out ?? false;
                    } else {
                        console.warn(`⚠️ Unexpected data format for ${date}:`, details);
                        continue;
                    }

                    newAvailability[date] = !soldOut; // Invert to indicate availability
                    const availabilityStr = `📅 ${date} - Available: ${!soldOut ? "✅ Yes" : "❌ No"}`;
                    console.log(availabilityStr);
                    startupReport.push(availabilityStr);

                    // 🚨 Detect and notify about availability changes
                    if (previousAvailability.hasOwnProperty(date) && previousAvailability[date] === false && !soldOut) {
                        console.log(`🚗 🚨 Availability change detected for ${date}!`);
                        await sendNotification("🚗 Weekend Parking Available!", `🚗 Parking is now available for ${date} at Stevens Pass. Book now!`);
                    }
                }

                // 📨 Send startup report
                await sendNotification("📊 Startup Parking Report", startupReport.join("\n"));

                // Update previous state
                previousAvailability = newAvailability;
            }
        } catch (err) {
            console.error("⚠️ Error parsing response JSON:", err);
        }
    });

    console.log("🔄 Starting periodic checks...");
    setInterval(async () => {
        console.log("🔄 Refreshing page for new data...");
        await page.reload({ waitUntil: "networkidle" });
    }, INTERVAL);

    // Schedule the first daily report
    scheduleDailyReport(previousAvailability);
};

scrapeParkingAvailability().catch(err => console.error("❌ Error:", err));