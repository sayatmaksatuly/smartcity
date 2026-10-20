import { test, expect, type Page } from "@playwright/test";
import type { ChatResponse as ChatReply } from "../src/types";
import {
  backFromMap,
  chooseOrigin,
  openConditions,
  stubTiles,
} from "./helpers";

test.beforeEach(async ({ page }) => stubTiles(page));

async function openChat(page: Page, withOrigin = true) {
  await page.goto("/");
  if (withOrigin) await chooseOrigin(page);
  await page.getByRole("button", { name: /^Спросить помощника/ }).click();
  await expect(page.getByLabel("Сообщение помощнику")).toBeVisible();
}

async function returnToChat(page: Page) {
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await page.getByRole("button", { name: /^Спросить помощника/ }).click();
  await expect(page.getByLabel("Сообщение помощнику")).toBeVisible();
}

async function chatAction(page: Page, action: () => Promise<unknown>) {
  const pending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chat" &&
      response.request().method() === "POST",
  );
  await action();
  const response = await pending;
  expect(response.ok()).toBe(true);
  const reply = (await response.json()) as ChatReply;
  return reply;
}

async function send(page: Page, message: string) {
  await page.getByLabel("Сообщение помощнику").fill(message);
  const reply = await chatAction(page, () =>
    page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click(),
  );
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]').last(),
  ).toContainText(reply.message);
  return reply;
}

async function expectSynchronizedPlaces(page: Page, reply: ChatReply) {
  const recommendations = reply.recommendation_response!.recommendations;
  expect(recommendations.length).toBeGreaterThan(0);
  const message = page.getByTestId("chat-message").last();
  await expect(message.getByTestId("chat-place")).toHaveCount(
    recommendations.length,
  );
  for (const result of recommendations) {
    await expect(
      message.getByTestId("chat-place").filter({ hasText: result.poi.name }),
    ).toBeVisible();
  }
  await page
    .getByRole("button", { name: "Посмотреть подбор", exact: true })
    .first()
    .click();
  await expect(page.getByTestId("result-card")).toHaveCount(
    recommendations.length,
  );
  await expect(page.locator(".applied-conditions")).toContainText(
    `${reply.context.preferences.duration_minutes} мин`,
  );
  for (const result of recommendations) {
    await expect(page.locator(`[id="result-${result.poi.id}"]`)).toContainText(
      result.poi.name,
    );
  }
  await page
    .getByRole("button", { name: "Показать на карте", exact: true })
    .click();
  await expect(page.locator(".result-marker")).toHaveCount(
    recommendations.length,
  );
  for (const result of recommendations) {
    await expect(
      page.locator(`.result-marker[title$="${result.poi.name}"]`),
    ).toHaveCount(1);
  }
  await backFromMap(page);
  await returnToChat(page);
}

test("conversation preserves exclusions while changing two hours to thirty minutes", async ({
  page,
}) => {
  await openChat(page);
  const first = await send(page, "Хочу кофе и погулять, у меня два часа");
  expect(first.context.preferences.duration_minutes).toBe(120);
  expect(
    first.recommendation_response!.recommendations.some(
      (item) => item.poi.category === "cafe",
    ),
  ).toBe(true);
  await openConditions(page);
  await expect(
    page.getByRole("button", { name: "2 часа", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  const excluded = await send(page, "Без кафе");
  expect(excluded.context.preferences.excluded_categories).toContain("cafe");
  expect(excluded.context.preferences.duration_minutes).toBe(120);
  expect(
    excluded.recommendation_response!.recommendations.every(
      (item) => item.poi.category !== "cafe",
    ),
  ).toBe(true);

  const closer = await send(page, "А можно поближе?");
  expect(closer.context.preferences.prefer_nearby).toBe(true);
  expect(closer.context.preferences.excluded_categories).toContain("cafe");
  const shorter = await send(page, "У меня теперь только 30 минут");
  expect(shorter.context.preferences.duration_minutes).toBe(30);
  expect(shorter.context.preferences.prefer_nearby).toBe(true);
  expect(shorter.context.preferences.excluded_categories).toContain("cafe");
  expect(
    shorter.recommendation_response!.recommendations.every(
      (item) =>
        item.poi.category !== "cafe" && item.total_minutes_estimate <= 30,
    ),
  ).toBe(true);
  await openConditions(page);
  await expect(
    page.getByRole("button", { name: "30 мин", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expectSynchronizedPlaces(page, shorter);
});

test("chat asks for a starting point and changes it only after explicit confirmation", async ({
  page,
}) => {
  await openChat(page, false);
  const initial = await send(page, "Хочу погулять, у меня два часа");
  expect(initial.action).toBe("clarify_origin");
  expect(initial.position).toBeNull();
  await expect(page.getByTestId("result-card")).toHaveCount(0);
  await expect(page.locator(".start-value:visible strong")).toContainText(
    "по умолчанию",
  );

  const named = await send(page, "Возле Mega Silk Way");
  expect(named.action).toBe("confirm_origin");
  expect(named.position).toBeNull();
  expect(named.origin_suggestions.map((poi) => poi.name)).toContain(
    "Mega Silk Way",
  );
  await expect(page.locator(".start-value:visible strong")).toContainText(
    "по умолчанию",
  );
  const confirmed = await chatAction(page, () =>
    page
      .getByRole("button", {
        name: "Начать отсюда: Mega Silk Way",
        exact: true,
      })
      .click(),
  );
  expect(confirmed.position).toEqual({ lat: 51.09, lon: 71.4 });
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Mega Silk Way",
  );
  await expectSynchronizedPlaces(page, confirmed);
  const next = await send(page, "Поближе");
  expect(next.position).toEqual(confirmed.position);
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Mega Silk Way",
  );
});

test("choosing a home origin does not resume an abandoned chat or erase a new draft", async ({
  page,
}) => {
  let chatRequests = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/chat" &&
      request.method() === "POST"
    )
      chatRequests++;
  });
  await openChat(page, false);
  const initial = await send(page, "Хочу погулять, у меня два часа");
  expect(initial.action).toBe("clarify_origin");
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  const query = page.getByLabel("Чего хочется сегодня?");
  await query.fill("Хочу выпить кофе рядом");
  await chooseOrigin(page);
  await expect(query).toHaveValue("Хочу выпить кофе рядом");
  expect(chatRequests).toBe(1);
  await expect(
    page.getByRole("heading", { level: 1, name: "Куда хотите сходить?" }),
  ).toBeVisible();
});

test("explicit filter edits override older chat preferences on the next turn", async ({
  page,
}) => {
  await openChat(page);
  await send(page, "Хочу погулять, у меня два часа, без кафе");
  await openConditions(page);
  await page.getByRole("button", { name: "60 мин", exact: true }).click();
  await page.getByRole("button", { name: "Всё", exact: true }).click();
  await page.getByRole("button", { name: "Кофе", exact: true }).click();
  const reply = await send(page, "Поближе");
  expect(reply.context.preferences.duration_minutes).toBe(60);
  expect(reply.context.preferences.categories).toEqual(["cafe"]);
  expect(reply.context.preferences.excluded_categories).not.toContain("cafe");
  expect(
    reply.recommendation_response!.recommendations.every(
      (item) => item.poi.category === "cafe",
    ),
  ).toBe(true);
  await expectSynchronizedPlaces(page, reply);
});

test("ordinary search preserves chat constraints until a new intent or new dialog replaces them", async ({
  page,
}) => {
  const paths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      ["/api/chat", "/api/recommendations"].includes(path)
    ) {
      paths.push(path);
    }
  });
  await openChat(page);
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  const query = page.getByLabel("Чего хочется сегодня?");
  await query.fill("Хочу кафе");
  await page.getByRole("button", { name: /^Спросить помощника/ }).click();
  const excluded = await send(page, "Без кафе");
  expect(excluded.context.preferences.excluded_categories).toContain("cafe");
  await send(page, "А можно поближе?");

  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await expect(query).toHaveValue("");
  const normalSearch = await chatAction(page, () =>
    page.getByRole("button", { name: "Найти место", exact: true }).click(),
  );
  expect(normalSearch.context.preferences.excluded_categories).toContain(
    "cafe",
  );
  expect(normalSearch.context.preferences.prefer_nearby).toBe(true);
  expect(
    normalSearch.recommendation_response!.recommendations.every(
      (item) => item.poi.category !== "cafe",
    ),
  ).toBe(true);
  await returnToChat(page);
  await expectSynchronizedPlaces(page, normalSearch);

  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await query.fill("Хочу кафе");
  const freshIntent = await chatAction(page, () =>
    page.getByRole("button", { name: "Найти место", exact: true }).click(),
  );
  expect(freshIntent.context.preferences.excluded_categories).not.toContain(
    "cafe",
  );
  expect(freshIntent.context.preferences.categories).toEqual(["cafe"]);
  expect(freshIntent.context.preferences.prefer_nearby).toBe(true);
  expect(
    freshIntent.recommendation_response!.recommendations.every(
      (item) => item.poi.category === "cafe",
    ),
  ).toBe(true);
  await returnToChat(page);
  await expectSynchronizedPlaces(page, freshIntent);
  expect(paths).toEqual(Array(4).fill("/api/chat"));

  await page.getByRole("button", { name: "Новый диалог", exact: true }).click();
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await query.fill("Хочу погулять");
  const ordinaryResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/recommendations" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Найти место", exact: true }).click();
  expect((await ordinaryResponse).ok()).toBe(true);
  await expect(
    page.getByTestId("result-card").filter({ hasText: "Fixture Park" }),
  ).toHaveCount(1);
  await returnToChat(page);
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  expect(paths.at(-1)).toBe("/api/recommendations");
});

test("an expired origin confirmation cannot rename the already confirmed start", async ({
  page,
}) => {
  await openChat(page);
  await send(page, "Хочу погулять");
  const suggested = await send(page, "Возле Mega Silk Way");
  expect(suggested.action).toBe("confirm_origin");
  await page.route("**/api/chat", async (route) => {
    const body = route.request().postDataJSON();
    // Model an expired client-carried suggestion, then let the real backend
    // reject it. No fake place or fabricated server response is introduced.
    if (body.action === "confirm_origin") {
      body.context.pending_origin_ids = [];
      await route.continue({ postData: JSON.stringify(body) });
    } else {
      await route.continue();
    }
  });
  const rejected = await chatAction(page, () =>
    page
      .getByRole("button", {
        name: "Начать отсюда: Mega Silk Way",
        exact: true,
      })
      .click(),
  );
  expect(rejected.action).toBe("clarify_origin");
  expect(rejected.position).toEqual({ lat: 51.1283, lon: 71.4306 });
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Fixture Park",
  );
  await expect(page.getByTestId("chat-message").last()).toContainText(
    "Старт не удалось подтвердить",
  );
});

test("chat, cards and map share selection, including selecting a place again", async ({
  page,
}) => {
  await openChat(page);
  const reply = await send(page, "Хочу кофе и погулять, у меня два часа");
  await expectSynchronizedPlaces(page, reply);
  const second = reply.recommendation_response!.recommendations[1];
  expect(second).toBeTruthy();
  const chatPlace = page
    .getByTestId("chat-message")
    .last()
    .getByTestId("chat-place")
    .filter({ hasText: second.poi.name });
  await chatPlace.click();
  await expect(page.locator(".map-caption h3")).toHaveText(second.poi.name);
  const selectedMarker = page.locator(".result-marker.is-selected");
  await expect(selectedMarker).toBeInViewport();
  const mapBounds = (await page.locator(".city-map").boundingBox())!;
  // Drag the real map away without changing selection or inspecting Leaflet's
  // internal state. Re-selecting the same place must bring its marker back.
  for (let drag = 0; drag < 2; drag++) {
    await page.mouse.move(
      mapBounds.x + mapBounds.width * 0.4,
      mapBounds.y + mapBounds.height * 0.55,
    );
    await page.mouse.down();
    await page.mouse.move(
      mapBounds.x + mapBounds.width * 0.95,
      mapBounds.y + mapBounds.height * 0.55,
      { steps: 15 },
    );
    await page.mouse.up();
  }
  await expect(selectedMarker).not.toBeInViewport();
  await backFromMap(page);
  await expect(chatPlace).toHaveAttribute("aria-pressed", "true");
  await chatPlace.click();
  await expect(selectedMarker).toBeInViewport({ ratio: 0.9 });
  await expect(selectedMarker).toHaveAttribute(
    "title",
    `2. ${second.poi.name}`,
  );
  await expect(page.locator(".map-caption h3")).toHaveText(second.poi.name);

  const first = reply.recommendation_response!.recommendations[0];
  await page.locator(".result-marker").first().click();
  await expect(page.locator(".map-caption h3")).toHaveText(first.poi.name);
  await backFromMap(page);
  await expect(page.locator(".start-value:visible strong")).toHaveText(
    "Fixture Park",
  );
  await expect(
    page.getByTestId("chat-message").last().getByTestId("chat-place").first(),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "Посмотреть подбор", exact: true })
    .first()
    .click();
  await page
    .locator(`[id="result-${second.poi.id}"]`)
    .getByRole("button", { name: /^Показать на карте:/ })
    .click();
  await expect(page.locator(".map-caption h3")).toHaveText(second.poi.name);
  await backFromMap(page);
  await returnToChat(page);
  await expect(chatPlace).toHaveAttribute("aria-pressed", "true");
});

test("more choices, previous choices and a historical place stay grounded and selectable", async ({
  page,
}) => {
  await openChat(page);
  const first = await send(page, "Покажи варианты, у меня два часа");
  const firstIds = first.context.shown_poi_ids;
  const more = await send(page, "Покажи ещё варианты");
  expect(more.context.shown_poi_ids.length).toBeGreaterThan(0);
  expect(more.context.shown_poi_ids.some((id) => firstIds.includes(id))).toBe(
    false,
  );
  await expectSynchronizedPlaces(page, more);
  const alternate = more.recommendation_response!.recommendations[0].poi;
  const previous = await send(page, "Вернёмся к предыдущему варианту");
  expect(previous.context.shown_poi_ids).toEqual(firstIds);
  await expectSynchronizedPlaces(page, previous);
  const selected = await chatAction(page, () =>
    page.getByTestId("chat-place").filter({ hasText: alternate.name }).click(),
  );
  expect(selected.action).toBe("selected");
  expect(selected.selected_poi_id).toBe(alternate.id);
  expect(
    selected.recommendation_response!.recommendations.some(
      (item) => item.poi.id === alternate.id,
    ),
  ).toBe(true);
  await expect(page.locator(".map-caption h3")).toHaveText(alternate.name);
  await backFromMap(page);
  await expectSynchronizedPlaces(page, selected);
});

test("mobile chat and map switching preserves conversation and selected place", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openChat(page);
  const reply = await send(page, "Хочу погулять, у меня час");
  const name = reply.recommendation_response!.recommendations[0].poi.name;
  await page
    .getByTestId("chat-message")
    .last()
    .getByTestId("chat-place")
    .first()
    .click();
  await expect(page.locator(".map-panel")).toBeVisible();
  await expect(page.locator(".map-caption h3")).toHaveText(name);
  await backFromMap(page);
  await expect(page.getByLabel("Сообщение помощнику")).toBeVisible();
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  const next = await send(page, "Без кафе");
  expect(next.context.preferences.excluded_categories).toContain("cafe");
  await page.screenshot({
    path: "../docs/screenshots/phase4-after-chat-conversation-390.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("empty input, Shift Enter, length limit, duplicate send and network retry are safe", async ({
  page,
}) => {
  let attempts = 0;
  let failFirst!: () => void;
  const firstFailure = new Promise<void>((resolve) => {
    failFirst = resolve;
  });
  await page.route("**/api/chat", async (route) => {
    attempts++;
    if (attempts === 1) {
      await firstFailure;
      await route.abort("connectionrefused");
    } else {
      await route.continue();
    }
  });
  await openChat(page);
  const input = page.getByLabel("Сообщение помощнику");
  const submit = page.getByRole("button", {
    name: "Отправить сообщение",
    exact: true,
  });
  await input.fill("   ");
  await expect(submit).toBeDisabled();
  await input.fill("Хочу погулять");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue("Хочу погулять\n");
  expect(attempts).toBe(0);
  await input.fill("а".repeat(650));
  await expect(input).toHaveValue("а".repeat(600));
  await input.fill("Хочу погулять, у меня час");
  await input.evaluate((element) => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  await expect(submit).toBeDisabled();
  await expect(page.locator(".chat-loading")).toBeVisible();
  await page.getByRole("button", { name: "На главную", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ищем подходящие места…", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Чего хочется сегодня?").press("Enter");
  await page.getByRole("button", { name: /^Спросить помощника/ }).click();
  expect(attempts).toBe(1);
  failFirst();
  await expect(page.locator(".chat-error")).toContainText("Ответ не получен");
  expect(attempts).toBe(1);
  await expect(
    page
      .getByTestId("chat-message")
      .filter({ has: page.locator(".chat-speaker", { hasText: "Вы" }) }),
  ).toHaveCount(1);
  const retry = await chatAction(page, () =>
    page
      .locator(".chat-error")
      .getByRole("button", { name: "Повторить", exact: true })
      .click(),
  );
  expect(attempts).toBe(2);
  expect(retry.recommendation_response!.mode).toBe("local");
  await expect(page.locator(".chat-error")).toHaveCount(0);
  await expect(page.getByTestId("chat-message")).toHaveCount(2);
  await expectSynchronizedPlaces(page, retry);
});

test("an older response cannot replace results after an explicit edit and a newer turn", async ({
  page,
}) => {
  // Exercise the stale-response guard even if a transport cannot cancel a request.
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/chat") && init) {
        return fetch(input, { ...init, signal: undefined });
      }
      return fetch(input, init);
    };
  });
  let releaseOld!: () => void;
  let readyOld!: () => void;
  let deliveredOld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    readyOld = resolve;
  });
  const delivered = new Promise<void>((resolve) => {
    deliveredOld = resolve;
  });
  let turns = 0;
  await page.route("**/api/chat", async (route) => {
    turns++;
    if (turns !== 1) return route.continue();
    const response = await route.fetch();
    readyOld();
    await held;
    await route.fulfill({ response });
    deliveredOld();
  });
  await openChat(page);
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Хочу погулять, у меня два часа");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await ready;
  await openConditions(page);
  await page.getByRole("button", { name: "30 мин", exact: true }).click();
  const newer = await send(page, "Поближе");
  expect(newer.context.preferences.duration_minutes).toBe(30);
  const newestMessage = await page
    .getByTestId("chat-message")
    .last()
    .textContent();
  releaseOld();
  await delivered;
  await expect(
    page.getByRole("button", { name: "30 мин", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("chat-message").last()).toHaveText(
    newestMessage!,
  );
  await expectSynchronizedPlaces(page, newer);
});

test("bounded session history retains constraints and a new dialog clears them", async ({
  page,
}) => {
  await openChat(page);
  await send(page, "Хочу погулять, у меня два часа, без кафе");
  for (const message of [
    "Поближе",
    "У меня 60 минут",
    "Лучше бесплатно",
    "У меня 30 минут",
  ]) {
    const reply = await send(page, message);
    expect(reply.context.preferences.excluded_categories).toContain("cafe");
    expect(reply.context.snapshots.length).toBeLessThanOrEqual(8);
  }
  await expect(page.getByTestId("chat-message")).toHaveCount(8);
  await expect(page.getByTestId("chat-message").first()).not.toContainText(
    "у меня два часа",
  );
  await page.getByRole("button", { name: "Новый диалог", exact: true }).click();
  await expect(page.getByTestId("chat-message")).toHaveCount(0);
  await expect(page.getByTestId("result-card")).toHaveCount(0);
  await expect(page.getByLabel("Сообщение помощнику")).toBeFocused();
  const reset = await send(page, "Хочу кофе");
  expect(reset.context.preferences.excluded_categories).toEqual([]);
  expect(reset.context.preferences.free_only).toBe(false);
  expect(
    reset.recommendation_response!.recommendations.some(
      (item) => item.poi.category === "cafe",
    ),
  ).toBe(true);
});

test("local fallback is explicit and unsupported conversation does not invent city facts", async ({
  page,
}) => {
  await openChat(page);
  const firstUnsupported = await send(page, "Расскажи анекдот о космосе");
  expect(firstUnsupported.action).toBe("unsupported");
  expect(firstUnsupported.recommendation_response).toBeNull();
  const supported = await send(page, "Хочу погулять бесплатно");
  expect(supported.context.preferences.free_only).toBe(true);
  expect(supported.recommendation_response!.mode).toBe("local");
  expect(supported.recommendation_response!.fallback_reason).toBe(
    "missing_key",
  );
  await expect(page.getByTestId("chat-message").last()).toContainText(
    "Локальный ответ · без ИИ",
  );
  await expect(page.getByTestId("chat-message").last()).toContainText(
    "Fixture Park",
  );
  const unsupported = await send(page, "Расскажи анекдот о космосе");
  expect(unsupported.action).toBe("unsupported");
  await expect(page.getByTestId("chat-message").last()).toContainText(
    "Локальный ответ · без ИИ",
  );
  await expect(page.getByTestId("chat-message").last()).not.toContainText(
    "Подобрано Gemini",
  );
  expect(unsupported.recommendation_response).toBeNull();
});
