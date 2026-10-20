import { test, expect } from "@playwright/test";
import {
  backFromMap,
  chooseOrigin,
  expectNoOverflow,
  openConditions,
  search,
  stubTiles,
} from "./helpers";

test.beforeEach(async ({ page }) => stubTiles(page));

test("home has one clear action and does not load a map or request geolocation", async ({
  page,
}) => {
  const mapRequests: string[] = [];
  const scriptErrors: string[] = [];
  page.on("pageerror", (error) => scriptErrors.push(error.message));
  page.on("request", (request) => {
    if (/tile\.openstreetmap|CityMap\.(tsx|js)|leaflet\.js/.test(request.url()))
      mapRequests.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: () => {
          throw new Error("Unsolicited geolocation");
        },
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Куда хотите сходить?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Найти место", exact: true }),
  ).toBeInViewport();
  for (const name of [
    "Найти место рядом",
    "Подобрать прогулку",
    "Спросить помощника",
  ]) {
    await expect(
      page.getByRole("button", { name: new RegExp(`^${name}`) }),
    ).toBeVisible();
  }
  await expect(page.locator(".city-map")).toHaveCount(0);
  await expect(page.getByLabel("Чего хочется сегодня?")).toHaveAttribute(
    "placeholder",
    /Хочу спокойно погулять/,
  );
  expect(mapRequests).toEqual([]);
  expect(scriptErrors).toEqual([]);
});

test("browser Back restores the previous view with recommendations intact", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Чего хочется сегодня?").fill("Хочу погулять");
  await search(page);
  const name = await page
    .getByTestId("result-card")
    .first()
    .locator("h3")
    .innerText();
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  await expect(page.locator(".city-map")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".results-title")).toBeVisible();
  await expect(page.getByTestId("result-card").first()).toContainText(name);
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Куда хотите сходить?", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Чего хочется сегодня?")).toHaveValue(
    "Хочу погулять",
  );
});

test("general map reopening preserves the viewport after a deliberate pan and zoom", async ({
  page,
}) => {
  await page.goto("/");
  await search(page);
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  const marker = page.locator(".result-marker.is-selected");
  await expect(marker).toBeInViewport();
  const bounds = (await page.locator(".city-map").boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.45,
    bounds.y + bounds.height * 0.4,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.65,
    bounds.y + bounds.height * 0.4,
    { steps: 15 },
  );
  await page.mouse.up();
  await page.locator(".leaflet-control-zoom-in").click();
  // Let Leaflet's finite pan/zoom animation finish before comparing pixels.
  await page.waitForTimeout(500);
  const before = (await marker.boundingBox())!;
  await backFromMap(page);
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  await expect
    .poll(async () => {
      const after = await marker.boundingBox();
      return after
        ? Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
        : Infinity;
    })
    .toBeLessThan(2);
});

test("map clicks only move the starting point in explicit picking mode", async ({
  page,
}) => {
  await page.goto("/");
  await chooseOrigin(page);
  await search(page);
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  const map = page.locator(".city-map");
  await expect(map).toBeVisible();
  const bounds = (await map.boundingBox())!;
  await map.click({
    position: { x: bounds.width * 0.75, y: bounds.height * 0.35 },
  });
  await backFromMap(page);
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Fixture Park",
  );
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Выбрать на карте", exact: true })
    .click();
  await map.click({
    position: { x: bounds.width * 0.75, y: bounds.height * 0.35 },
  });
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Выбранная точка",
  );
});

test("200 percent CSS zoom keeps the search and results usable without overflow", async ({
  page,
}) => {
  // CSS zoom exercises a real rendered 200% layout; this is not an OS/browser
  // settings audit or a claim about assistive technology testing.
  await page.goto("/");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });
  await expectNoOverflow(page);
  await page.getByLabel("Чего хочется сегодня?").fill("Хочу погулять");
  await search(page);
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({
    path: "../docs/screenshots/phase4-after-zoom-200.png",
    fullPage: true,
  });
});

test("route A keeps results and origin across explicit map and home navigation", async ({
  page,
  request,
}) => {
  expect(
    (await (await request.get("/api/data-status")).json()).count,
  ).toBeGreaterThan(0);
  await page.goto("/");
  await chooseOrigin(page);
  await page.getByLabel("Чего хочется сегодня?").fill("Хочу кофе и погулять");
  await search(page);
  const cards = page.getByTestId("result-card");
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(3);
  await expect(page.locator(".city-map")).toHaveCount(0);
  const selected = cards.nth(count > 1 ? 1 : 0);
  const name = await selected.locator("h3").innerText();
  await selected.getByRole("button", { name: /^Показать на карте:/ }).click();
  await expect(page.locator(".map-panel")).toBeVisible();
  await expect(page.locator(".result-marker")).toHaveCount(count);
  await expect(page.locator(".map-caption h3")).toHaveText(name);
  await page.locator(".result-marker").first().click();
  await backFromMap(page);
  await expect(cards).toHaveCount(count);
  await expect(
    cards.first().getByRole("button", { name: /^Показать на карте:/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".start-value:visible strong").first()).toHaveText(
    "Fixture Park",
  );
  await cards.first().locator("summary").click();
  await expect(
    cards.first().getByRole("link", { name: "Источник OSM" }),
  ).toHaveAttribute("href", /^https:\/\/www.openstreetmap.org\//);
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Куда хотите сходить?" }),
  ).toBeVisible();
  await expect(page.locator(".start-value:visible strong").first()).toHaveText(
    "Fixture Park",
  );
  await expect(page.getByLabel("Чего хочется сегодня?")).toHaveValue(
    "Хочу кофе и погулять",
  );
});

test("route B exposes time and interests before returning recommendations", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^Подобрать прогулку/ }).click();
  await page.getByRole("button", { name: "2 часа", exact: true }).click();
  await page.getByRole("button", { name: "Природа", exact: true }).click();
  await search(page);
  await expect(page.getByTestId("result-card")).toContainText("Fixture Park");
  await expect(page.locator(".applied-conditions")).toContainText("120 мин");
  await expect(page.locator(".city-map")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Изменить запрос", exact: true })
    .click();
  await openConditions(page);
  await expect(
    page.getByRole("button", { name: "2 часа", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("named starting point comes from the isolated fixture import", async ({
  page,
}) => {
  await page.goto("/");
  await chooseOrigin(page, "Mega Silk Way");
  await search(page);
  await expect(page.getByTestId("result-card").first()).toBeVisible();
});

test("explicit geolocation uses a synthetic permitted position", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 51.13, longitude: 71.43 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Определить моё местоположение", exact: true })
    .click();
  await expect(page.locator(".start-value:visible strong").first()).toHaveText(
    "Моё местоположение",
  );
});

test("manual coordinates and no matches", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .first()
    .click();
  await page.locator(".manual-coordinates summary").click();
  await page.getByLabel("Широта", { exact: true }).fill("0");
  await page.getByLabel("Долгота", { exact: true }).fill("0");
  await page
    .getByRole("button", { name: "Выбрать точку", exact: true })
    .click();
  await page.getByRole("button", { name: "Найти место", exact: true }).click();
  await expect(page.getByText("Пока без совпадений")).toBeVisible();
  await expect(page.getByTestId("result-card")).toHaveCount(0);
});

test("loading, backend error and retry", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/recommendations", async (route) => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      status: 503,
      json: { detail: "Тестовая недоступность сервиса" },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Найти место", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ищем подходящие места…" }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "Тестовая недоступность сервиса",
  );
  await page.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect.poll(() => attempts).toBe(2);
  await expect(page.getByRole("alert")).toContainText(
    "Тестовая недоступность сервиса",
  );
});

test("empty database state is honest and prevents a search", async ({
  page,
}) => {
  await page.route("**/api/data-status", (route) =>
    route.fulfill({
      json: { count: 0, last_import: null, ai_configured: false },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".no-data")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Найти место", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".city-map")).toHaveCount(0);
});

for (const width of [320, 390, 768, 1440]) {
  test(`all primary views fit ${width}px and preserve navigation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.goto("/");
    await expectNoOverflow(page);
    await expect(
      page.getByRole("button", { name: "Найти место", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: `../docs/screenshots/phase4-after-home-${width}.png`,
      fullPage: true,
    });
    await search(page);
    await expectNoOverflow(page);
    await page.screenshot({
      path: `../docs/screenshots/phase4-after-results-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Показать на карте", exact: true })
      .click();
    await expect(page.locator(".city-map")).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({
      path: `../docs/screenshots/phase4-after-map-${width}.png`,
      fullPage: true,
    });
    await backFromMap(page);
    await expect(page.getByTestId("result-card").first()).toBeVisible();
    await page.getByRole("button", { name: "На главную", exact: true }).click();
    await page.getByRole("button", { name: /^Спросить помощника/ }).click();
    await expect(page.getByLabel("Сообщение помощнику")).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({
      path: `../docs/screenshots/phase4-after-chat-${width}.png`,
      fullPage: true,
    });
  });
}

test("mixed interests and negation reach actual retrieval", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Чего хочется сегодня?")
    .fill("Хочу выпить кофе и погулять");
  await search(page);
  await expect(
    page.getByTestId("result-card").filter({ hasText: "Fixture Cafe" }),
  ).toHaveCount(1);
  await expect(
    page.getByTestId("result-card").filter({ hasText: "Fixture Park" }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "Изменить запрос", exact: true })
    .click();
  await page
    .getByLabel("Чего хочется сегодня?")
    .fill("Не хочу в кафе, лучше парк");
  await search(page);
  await expect(page.getByTestId("result-card")).toHaveCount(1);
  await expect(page.getByTestId("result-card")).toContainText("Fixture Park");
});

test("mentioned origin and duration need separate confirmation", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Чего хочется сегодня?")
    .fill("Я возле Mega Silk Way, у меня 40 минут");
  await search(page);
  await expect(
    page.locator(".start-value:visible strong").first(),
  ).toContainText("по умолчанию");
  await expect(page.locator(".applied-conditions")).toContainText("60 мин");
  await page
    .getByRole("button", { name: "Выбрать старт и пересчитать: Mega Silk Way" })
    .click();
  await expect(page.locator(".start-value:visible strong").first()).toHaveText(
    "Mega Silk Way",
  );
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Применить время из запроса: 40 мин" })
    .click();
  await expect(page.locator(".applied-conditions")).toContainText("40 мин");
});

test("explicit categories win and conflicts remain visible", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Чего хочется сегодня?")
    .fill("Не хочу кафе, лучше парк");
  await openConditions(page);
  await page.getByRole("button", { name: "Кофе", exact: true }).click();
  await search(page);
  await expect(page.locator(".intent-warning")).toContainText(
    "категории из фильтра",
  );
  await expect(page.getByTestId("result-card")).toContainText("Fixture Cafe");
  await page.getByTestId("result-card").locator("summary").click();
  await expect(page.getByTestId("result-card")).toContainText(
    "Часы не подтверждены",
  );
});

test("keyboard search focuses results and Escape returns focus from the start dialog", async ({
  page,
}) => {
  await page.goto("/");
  const origin = page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .first();
  await origin.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(origin).toBeFocused();
  await page.getByRole("button", { name: "Найти место", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".results-section")).toBeFocused();
  await expect(page.locator(".results-title")).toBeInViewport();
});

test("failed map tiles remain visible until explicit retry", async ({
  page,
}) => {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.abort(),
  );
  await page.goto("/");
  await search(page);
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  await expect(page.locator(".tile-error")).toContainText(
    "Часть карты не загрузилась",
  );
  await stubTiles(page);
  await page
    .getByRole("button", { name: "Обновить карту", exact: true })
    .click();
  await expect(page.locator(".tile-error")).toHaveCount(0);
  await backFromMap(page);
  await expect(page.getByTestId("result-card").first()).toBeVisible();
});

test("rejected geolocation and offline map notice stay actionable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (
          _success: unknown,
          failure: (error: { code: number }) => void,
        ) => failure({ code: 1 }),
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Определить моё местоположение", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Геолокация недоступна");
  await page.keyboard.press("Escape");
  await search(page);
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  await expect(page.locator(".city-map")).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.locator(".tile-error")).toContainText(
    "Нет подключения к интернету",
  );
});
