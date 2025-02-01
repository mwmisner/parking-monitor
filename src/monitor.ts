import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { chromium } from "playwright";
import { promises as fs } from "fs";

const CONFIG_FILE_PATH = "./config.json";

type Config = {
  snsTopicArn: string;
  region: string;
  interval: number;         // in milliseconds
  dailyReportHour: number;  // hour in UTC when the daily report should be sent
  monitorDates: string[];   // array of dates (YYYY-MM-DD) to monitor; if empty, auto-generate dates
};

let config: Config;

// Loads configuration from the JSON file.
async function loadConfig(): Promise<void> {
  try {
    const data = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
    config = JSON.parse(data);
    console.log("🛠 Config loaded:", config);
  } catch (err) {
    console.error("❌ Error loading config:", err);
    throw err;
  }
}

// Helper function to generate dates (formatted as YYYY-MM-DD) from tomorrow until a specified number of months in the future.
function generateDatesForNextMonths(months: number): string[] {
  const dates: string[] = [];
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 1); // start from tomorrow
  const endDate = new Date();
  endDate.setMonth(endDate.getMonth() + months);

  for (let dt = new Date(startDate); dt <= endDate; dt.setDate(dt.getDate() + 1)) {
    const year = dt.getFullYear();
    const month = (dt.getMonth() + 1).toString().padStart(2, "0");
    const day = dt.getDate().toString().padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
  }
  return dates;
}

// Returns the list of dates to monitor.
// If monitorDates is provided in the config (non-empty), it will be used; otherwise, auto-generate dates for the next 3 months.
function getMonitorDates(): string[] {
  if (config.monitorDates && config.monitorDates.length > 0) {
    return config.monitorDates;
  }
  return generateDatesForNextMonths(3);
}

let snsClient: SNSClient;

// Sends an SNS notification.
async function sendNotification(subject: string, message: string) {
  const params = {
    Subject: subject,
    Message: message,
    TopicArn: config.snsTopicArn,
  };

  try {
    await snsClient.send(new PublishCommand(params));
    console.log(`📧 SNS Notification Sent: ${subject}`);
  } catch (err) {
    console.error("❌ Error sending SNS notification:", err);
  }
}

// Sends the daily parking report.
async function sendDailyReport(availability: Record<string, boolean>) {
  const report: string[] = ["📊 **Daily Parking Availability Report**"];
  for (const [date, available] of Object.entries(availability)) {
    report.push(`📅 ${date} - Available: ${available ? "✅ Yes" : "❌ No"}`);
  }
  await sendNotification("📊 Daily Parking Report", report.join("\n"));
}

// Schedules the daily report at a fixed UTC hour.
function scheduleDailyReport(previousAvailability: Record<string, boolean>) {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(config.dailyReportHour, 0, 0, 0);
  // If the scheduled time has already passed today, set it for tomorrow.
  if (now > nextRun) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }
  const delay = nextRun.getTime() - now.getTime();
  console.log(`⏳ Scheduling next daily report in ${Math.round(delay / 1000 / 60)} minutes`);

  setTimeout(async () => {
    await sendDailyReport(previousAvailability);
    scheduleDailyReport(previousAvailability); // Reschedule for the next day.
  }, delay);
}

let previousAvailability: Record<string, boolean> = {};

// The main business logic: launch a browser, listen for network responses from the parking page,
// and detect changes in parking availability.
const scrapeParkingAvailability = async () => {
  console.log("🚀 Launching browser...");
  await sendNotification(
    "🚀 Parking Monitor Started",
    "The parking availability monitor has started successfully and is now tracking updates."
  );

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/120.0.0.0",
  });
  const page = await context.newPage();
  console.log("🌍 Navigating to parking page...");
  await page.goto("https://reservenski.parkstevenspass.com/select-parking", { waitUntil: "domcontentloaded" });

  console.log("📡 Setting up network listener...");
  page.on("response", async (response) => {
    if (!response.url().includes("graphql")) return;

    try {
      const json = await response.json();
      if (json?.data?.publicParkingAvailability) {
        const newAvailability: Record<string, boolean> = {};
        let startupReport: string[] = ["📊 **Current Weekend Parking Availability:**"];

        // Determine which dates to monitor.
        const monitorDates = getMonitorDates();

        // Process each entry in the parking availability data.
        for (const [date, details] of Object.entries(json.data.publicParkingAvailability)) {
          // Only process dates that are in our monitor list.
          if (!monitorDates.includes(date)) continue;

          let soldOut = false;
          if (typeof details === "object" && details !== null && "status" in details) {
            soldOut = (details as { status: { sold_out: boolean } }).status.sold_out ?? false;
          } else {
            console.warn(`⚠️ Unexpected data format for ${date}:`, details);
            continue;
          }

          // Invert soldOut to indicate availability.
          newAvailability[date] = !soldOut;
          const availabilityStr = `📅 ${date} - Available: ${!soldOut ? "✅ Yes" : "❌ No"}`;
          console.log(availabilityStr);
          startupReport.push(availabilityStr);

          // 🚨 Detect and notify about availability changes.
          if (previousAvailability.hasOwnProperty(date) && previousAvailability[date] === false && !soldOut) {
            console.log(`🚗 🚨 Availability change detected for ${date}!`);
            await sendNotification(
              "🚗 Weekend Parking Available!",
              `🚗 Parking is now available for ${date} at Stevens Pass. Book now!`
            );
          }
        }

        // Send a startup report.
        await sendNotification("📊 Startup Parking Report", startupReport.join("\n"));
        // Update previous state.
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
  }, config.interval);

  // Schedule the first daily report.
  scheduleDailyReport(previousAvailability);
};

// Initializes configuration, creates the SNS client, and starts the monitoring process.
async function startMonitoring() {
  await loadConfig();
  snsClient = new SNSClient({ region: config.region });
  await scrapeParkingAvailability();
}

startMonitoring().catch(err => console.error("❌ Error:", err));