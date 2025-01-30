import { chromium } from 'playwright';

async function checkAvailability(targetDate: string): Promise<boolean> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // Navigate to the reservation page
    await page.goto('https://reservenski.parkstevenspass.com/select-parking', {
      waitUntil: 'networkidle',
    });

    // Wait for the page to load content
    await page.waitForSelector('.date-selector'); // Adjust the selector as needed

    // Locate the date element (this will depend on the page's structure)
    const isAvailable = await page.evaluate((date) => {
      const dateElement = document.querySelector(`[data-date='${date}']`);
      if (dateElement) {
        return !dateElement.classList.contains('sold-out');
      }
      return false;
    }, targetDate);

    return isAvailable;
  } catch (error) {
    console.error(`An error occurred: ${error}`);
    return false;
  } finally {
    await browser.close();
  }
}

(async () => {
  const targetDate = '2025-02-05'; // Specify the target date in YYYY-MM-DD format

  while (true) {
    const available = await checkAvailability(targetDate);
    if (available) {
      console.log(`Parking is now available for ${targetDate}!`);
      // Optionally, send a notification or take further action
      break;
    } else {
      console.log(`Parking is still sold out for ${targetDate}.`);
    }

    // Wait before checking again (e.g., check every hour)
    await new Promise((resolve) => setTimeout(resolve, 3600000));
  }
})();
