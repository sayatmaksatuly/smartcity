import { expect, test, type Page, type Route } from "@playwright/test";
import {
  backFromMap,
  chooseOrigin,
  expectNoOverflow,
  search,
  stubTiles,
} from "./helpers";

type RouteInput = {
  origin: { lat: number; lon: number };
  poi_ids: string[];
  round_trip: boolean;
  duration_minutes: number;
};

// Deliberately synthetic provider geometry: tests UI state and coordinate ordering,
// never claims availability of a live walking route or touches production POIs.
function routeResult(input: RouteInput, overrides = {}) {
  const fixtureCoordinates: Record<string, [number, number]> = {
    "node/1": [71.4306, 51.1283],
    "node/2": [71.432, 51.13],
    "node/3": [71.432, 51.129],
    "node/5": [71.4307, 51.1284],
  };
  const start = [input.origin.lon, input.origin.lat];
  return {
    provider: "openrouteservice",
    profile: "foot-walking",
    geometry: {
      type: "LineString",
      coordinates: [
        start,
        [input.origin.lon + 0.0001, input.origin.lat + 0.0003],
        [input.origin.lon + 0.0004, input.origin.lat + 0.0003],
        ...input.poi_ids.map((id) => fixtureCoordinates[id]),
        ...(input.round_trip ? [start] : []),
      ],
    },
    distance_m: 1250,
    duration_seconds: 930,
    visit_minutes: 30,
    total_minutes: 46,
    feasible: true,
    poi_ids: input.poi_ids,
    round_trip: input.round_trip,
    attribution: "© OpenStreetMap contributors",
    ...overrides,
  };
}

async function stubRoutes(
  page: Page,
  respond?: (route: Route, input: RouteInput) => Promise<void>,
) {
  const calls: RouteInput[] = [];
  await page.route("**/api/routes", async (route) => {
    const input = route.request().postDataJSON() as RouteInput;
    calls.push(input);
    if (respond) await respond(route, input);
    else await route.fulfill({ json: routeResult(input) });
  });
  return calls;
}

test.beforeEach(async ({ page }) => {
  await stubTiles(page);
  await page.route("https://aitu-test.supabase.co/**", (route) =>
    route.abort(),
  );
});

test("guest confirms the default origin before requesting one walking route", async ({
  page,
}) => {
  const calls = await stubRoutes(page);
  await page.goto("/");
  await search(page);
  const name = await page
    .getByTestId("result-card")
    .first()
    .locator("h3")
    .innerText();
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("button", { name: /^Маршрут:/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Откуда построить маршрут?" }),
  ).toBeVisible();
  expect(calls).toHaveLength(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Начать из центра Астаны", exact: true })
    .click();
  await expect(page.locator(".route-summary")).toContainText("1,3 км");
  await expect(page.locator(".route-summary")).toContainText("16 мин");
  await expect(page.locator("path.walking-route")).toHaveCount(1);
  expect(calls).toHaveLength(1);
  expect(calls[0].poi_ids).toHaveLength(1);
  await backFromMap(page);
  await expect(page.getByTestId("result-card").first()).toContainText(name);
});

test("each destination updates the guest route without losing the recommendation set", async ({
  page,
}) => {
  const calls = await stubRoutes(page);
  await page.goto("/");
  await chooseOrigin(page);
  await search(page);
  const count = await page.getByTestId("result-card").count();
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("button", { name: /^Маршрут:/ })
    .click();
  await expect(page.locator(".route-summary")).toBeVisible();
  const destinations = page.locator(".route-destinations button");
  await expect(destinations).toHaveCount(count);
  for (let index = 0; index < count; index++) {
    await destinations.nth(index).click();
    await expect(destinations.nth(index)).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator(".route-summary")).toBeVisible();
  }
  expect(new Set(calls.map((call) => call.poi_ids[0])).size).toBe(count);
  await backFromMap(page);
  await expect(page.getByTestId("result-card")).toHaveCount(count);
});

test("explicit GPS displays accuracy and an active route recalculates after manual start change", async ({
  page,
  context,
}) => {
  const calls = await stubRoutes(page);
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({
    latitude: 51.13,
    longitude: 71.43,
    accuracy: 17,
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Определить моё местоположение", exact: true })
    .click();
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Моё местоположение",
  );
  await search(page);
  const count = await page.getByTestId("result-card").count();
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("button", { name: /^Маршрут:/ })
    .click();
  await expect(page.locator(".route-summary")).toBeVisible();
  await expect(page.locator(".geo-accuracy")).toContainText("±17 м");
  await expect(page.locator(".origin-marker")).toHaveAttribute(
    "title",
    "Вы здесь",
  );
  expect(calls[0].origin).toEqual({ lat: 51.13, lon: 71.43 });
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .click();
  await page.locator(".manual-coordinates summary").click();
  await page.getByLabel("Широта", { exact: true }).fill("51.129");
  await page.getByLabel("Долгота", { exact: true }).fill("71.431");
  await page
    .getByRole("button", { name: "Выбрать точку", exact: true })
    .click();
  await expect(page.locator(".route-summary")).toBeVisible();
  await expect
    .poll(() => calls.at(-1)?.origin)
    .toEqual({ lat: 51.129, lon: 71.431 });
  await expect(page.locator(".route-destinations button")).toHaveCount(count);
  await expect(page.locator(".geo-accuracy")).toHaveCount(0);
});

test("a late GPS callback after closing the picker cannot replace the existing origin", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(success: (position: GeolocationPosition) => void) {
          (
            window as unknown as { completeTestLocation: () => void }
          ).completeTestLocation = () =>
            success({
              coords: { latitude: 51.13, longitude: 71.43, accuracy: 20 },
            } as GeolocationPosition);
        },
      },
    });
  });
  await page.goto("/");
  await chooseOrigin(page);
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Определить моё местоположение", exact: true })
    .click();
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (
      window as unknown as { completeTestLocation: () => void }
    ).completeTestLocation(),
  );
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Fixture Park",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("opening a route prevents an obsolete chat response from replacing its places", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await stubRoutes(page);
  await page.route("**/api/chat", async (route) => {
    const response = await route.fetch();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({ response }).catch(() => {});
  });
  await page.goto("/");
  await chooseOrigin(page);
  await search(page);
  const initialTitle = await page
    .getByTestId("result-card")
    .first()
    .locator("h3")
    .innerText();
  await page
    .getByRole("button", { name: "Спросить помощника", exact: true })
    .click();
  await page.getByLabel("Сообщение помощнику").fill("Хочу кафе");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page
    .getByRole("button", { name: "Посмотреть подбор", exact: true })
    .first()
    .click();
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("button", { name: /^Маршрут:/ })
    .click();
  await expect(page.locator(".route-summary")).toBeVisible();
  release?.();
  await expect(page.locator(".routing-panel h2")).toHaveText(initialTitle);
  await expect(page.locator("path.walking-route")).toHaveCount(1);
});

test("a multi-stop walk uses selection order and reports an insufficient time budget", async ({
  page,
}) => {
  const calls = await stubRoutes(page, (route, input) =>
    route.fulfill({
      json: routeResult(input, { total_minutes: 125, feasible: false }),
    }),
  );
  await page.goto("/");
  await chooseOrigin(page);
  await search(page);
  const cards = page.getByTestId("result-card");
  const ids = await cards.evaluateAll((elements) =>
    elements.map((element) => element.id.replace("result-", "")),
  );
  await page
    .getByRole("button", { name: "Составить прогулку", exact: true })
    .click();
  const stops = page.locator(".route-stops button");
  await stops.nth(1).click();
  await stops.nth(0).click();
  await expect(stops.nth(1)).toHaveText(/^1\./);
  await expect(stops.nth(0)).toHaveText(/^2\./);
  await page
    .getByRole("button", { name: "Проверить прогулку", exact: true })
    .click();
  await expect(page.locator(".route-summary")).toContainText(
    "В выбранное время не укладывается",
  );
  expect(calls.at(-1)?.poi_ids).toEqual([ids[1], ids[0]]);
  await expect(
    page.getByRole("button", { name: "Сохранить прогулку", exact: true }),
  ).toHaveCount(0);
});

for (const code of ["routing_no_route", "routing_unavailable"]) {
  test(`${code} preserves places and an explicit retry can recover`, async ({
    page,
  }) => {
    let fail = true;
    await stubRoutes(page, async (route, input) => {
      if (fail)
        await route.fulfill({ status: 503, json: { detail: { code } } });
      else await route.fulfill({ json: routeResult(input) });
    });
    await page.goto("/");
    await chooseOrigin(page);
    await search(page);
    const count = await page.getByTestId("result-card").count();
    await page
      .getByTestId("result-card")
      .first()
      .getByRole("button", { name: /^Маршрут:/ })
      .click();
    await expect(page.locator(".route-error")).toBeVisible();
    await expect(page.locator("path.walking-route")).toHaveCount(0);
    await expect(page.locator(".route-destinations button")).toHaveCount(count);
    fail = false;
    await page
      .locator(".route-error")
      .getByRole("button", { name: "Повторить", exact: true })
      .click();
    await expect(page.locator(".route-summary")).toBeVisible();
    await expect(page.locator("path.walking-route")).toHaveCount(1);
    await backFromMap(page);
    await expect(page.getByTestId("result-card")).toHaveCount(count);
  });
}

test("new destination replaces an obsolete response without displaying the old route", async ({
  page,
}) => {
  let completeFirst: (() => void) | undefined;
  let call = 0;
  await stubRoutes(page, async (route, input) => {
    call++;
    if (call === 1) {
      await new Promise<void>((resolve) => {
        completeFirst = resolve;
      });
      await route
        .fulfill({ json: routeResult(input, { distance_m: 9999 }) })
        .catch(() => {});
    } else
      await route.fulfill({ json: routeResult(input, { distance_m: 250 }) });
  });
  await page.goto("/");
  await chooseOrigin(page);
  await search(page);
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("button", { name: /^Маршрут:/ })
    .click();
  await expect(page.locator(".route-pending")).toContainText(
    "Ищем пешеходный маршрут",
  );
  await page.locator(".route-destinations button").nth(1).click();
  await expect(page.locator(".route-summary")).toContainText("250 м");
  completeFirst?.();
  await expect(page.locator(".route-summary")).not.toContainText("10,0 км");
  await expect(
    page.locator(".route-destinations button").nth(1),
  ).toHaveAttribute("aria-pressed", "true");
});

for (const width of [1440, 1280, 768, 390, 320]) {
  test(`guest routing and auth entry fit ${width}px`, async ({ page }) => {
    await stubRoutes(page);
    await page.setViewportSize({ width, height: width >= 1280 ? 1000 : 844 });
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    await expectNoOverflow(page);
    await expect(
      page.getByRole("button", { name: "Найти место", exact: true }),
    ).toBeInViewport();
    await page.screenshot({
      path: `../docs/screenshots/phase5-test-home-${width}.png`,
      fullPage: true,
    });
    await chooseOrigin(page);
    await search(page);
    await expectNoOverflow(page);
    await page.screenshot({
      path: `../docs/screenshots/phase5-test-results-${width}.png`,
      fullPage: true,
    });
    await page
      .getByTestId("result-card")
      .first()
      .getByRole("button", { name: /^Маршрут:/ })
      .click();
    await expect(page.locator(".route-summary")).toBeVisible();
    await expect(page.locator("path.walking-route")).toHaveCount(1);
    await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
    await expect(page.locator(".map-caption")).toHaveCount(0);
    const markerBounds = (await page
      .locator(".result-marker.is-selected")
      .boundingBox())!;
    const mapBounds = (await page.locator(".city-map").boundingBox())!;
    expect(markerBounds.y).toBeGreaterThanOrEqual(mapBounds.y);
    expect(markerBounds.y + markerBounds.height).toBeLessThanOrEqual(
      mapBounds.y + mapBounds.height,
    );
    await expect(
      page.locator(".route-destinations button").nth(1),
    ).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({
      path: `../docs/screenshots/phase5-test-route-${width}.png`,
      fullPage: true,
    });
    await backFromMap(page);
    await page
      .getByTestId("result-card")
      .first()
      .getByRole("button", { name: /^В избранное/ })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expectNoOverflow(page);
    await page.screenshot({
      path: `../docs/screenshots/phase5-test-auth-${width}.png`,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("result-card").first()).toBeVisible();
  });
}
