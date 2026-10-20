// Bounded visual QA against the existing real SQLite, using the local non-AI API.
// Does not capture console/network content or request payloads.
import { chromium } from "../frontend/node_modules/@playwright/test/index.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const observations = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({
      viewport: { width, height: width === 1440 ? 1000 : 844 },
    });
    let pageErrors = 0;
    let tilesRequested = 0;
    page.on("pageerror", () => pageErrors++);
    page.on("request", (request) => {
      if (request.url().startsWith("https://tile.openstreetmap.org/"))
        tilesRequested++;
    });
    await page.goto("http://127.0.0.1:5175/");
    await page.getByRole("heading", { name: "Куда хотите сходить?" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `${output}phase4-real-home-${width}.png`,
      fullPage: true,
    });
    const initialTiles = tilesRequested;
    const initialMap = await page.locator(".leaflet-container").count();
    await page.getByRole("button", { name: /^Подобрать прогулку/ }).click();
    await page.screenshot({
      path: `${output}phase4-real-plan-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "На главную", exact: true }).click();
    await page.getByRole("button", { name: /^Спросить помощника/ }).click();
    await page.screenshot({
      path: `${output}phase4-real-chat-entry-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "На главную", exact: true }).click();
    await page
      .getByLabel("Чего хочется сегодня?")
      .fill("Хочу погулять на свежем воздухе");
    await page
      .getByRole("button", { name: "Найти место", exact: true })
      .click();
    await page.locator(".result-list .result-card").first().waitFor();
    await page.screenshot({
      path: `${output}phase4-real-results-${width}.png`,
      fullPage: true,
    });
    const count = await page.locator(".result-list .result-card").count();
    const modeLocal = await page.locator(".mode-label.local").isVisible();
    await page
      .getByRole("button", { name: "Показать на карте", exact: true })
      .click();
    await page
      .locator(".leaflet-tile-loaded")
      .first()
      .waitFor({ timeout: 12000 })
      .catch(() => {});
    await page.screenshot({
      path: `${output}phase4-real-map-${width}.png`,
      fullPage: true,
    });
    const tileError = await page.locator(".tile-error").isVisible();
    await page
      .getByRole("button", { name: "Вернуться к результатам", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Спросить помощника", exact: true })
      .click();
    await page
      .getByLabel("Сообщение помощнику")
      .fill("Красивые места, но без кафе. Теперь 30 минут");
    await page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    await page.locator('.chat-message[data-role="assistant"]').waitFor();
    const currentStart = page.getByRole("button", {
      name: "Использовать выбранную точку",
      exact: true,
    });
    if (await currentStart.isVisible()) await currentStart.click();
    await page.locator(".chat-places").last().waitFor();
    await page.screenshot({
      path: `${output}phase4-real-chat-${width}.png`,
      fullPage: true,
    });
    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    observations.push({
      width,
      pageErrors,
      initialTiles,
      initialMap,
      count,
      modeLocal,
      tilesRequested,
      tileError,
      noOverflow,
    });
    await page.close();
  }
  await writeFile(
    `${output}phase4-real-observations.json`,
    JSON.stringify(observations, null, 2),
  );
  process.stdout.write(JSON.stringify(observations, null, 2));
} finally {
  await browser.close();
}
