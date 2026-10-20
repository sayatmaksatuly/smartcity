import { expect, test, type Page } from "@playwright/test";
import { search, stubTiles } from "./helpers";

// Only deterministic SDK-contract tests. The configured hostname is fake and every
// request is intercepted: no accounts, email or personal data are sent to Supabase.
const user = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  aud: "authenticated",
  role: "authenticated",
  email: "tester@example.invalid",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
const session = () => ({
  access_token: "test-only.not-a-valid-token.signature",
  refresh_token: "test-only-refresh",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user,
});
type SavedRecord = {
  id: string;
  user_id: string;
  title: string;
  ordered_poi_ids: string[];
  user_preferences: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

async function mockAccount(
  page: Page,
  options: {
    favorites?: string[];
    failData?: boolean;
    invalidLogin?: boolean;
    delayLogin?: boolean;
  } = {},
) {
  const state = {
    favorites: options.favorites ?? [],
    walks: [] as SavedRecord[],
    name: "Тестовый участник",
    preferences: {} as Record<string, unknown>,
    signIns: 0,
    signUps: 0,
    recoveries: 0,
    mutations: [] as Record<string, unknown>[],
    failData: options.failData ?? false,
  };
  await page.route("https://aitu-test.supabase.co/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    if (url.pathname === "/auth/v1/token") {
      state.signIns++;
      if (options.delayLogin)
        await new Promise((resolve) => setTimeout(resolve, 250));
      if (options.invalidLogin)
        await route.fulfill({
          status: 400,
          headers: {
            "X-Supabase-Api-Version": "2024-01-01",
            "Access-Control-Expose-Headers": "X-Supabase-Api-Version",
          },
          json: { code: "invalid_credentials", msg: "PRIVATE_PROVIDER_DETAIL" },
        });
      else await route.fulfill({ json: session() });
      return;
    }
    if (url.pathname === "/auth/v1/signup") {
      state.signUps++;
      await route.fulfill({ json: { user, session: null } });
      return;
    }
    if (url.pathname === "/auth/v1/recover") {
      state.recoveries++;
      await route.fulfill({ json: {} });
      return;
    }
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({ json: { ...user } });
      return;
    }
    if (url.pathname === "/auth/v1/logout") {
      await route.fulfill({ status: 204 });
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (state.failData) {
        await route.fulfill({
          status: 503,
          json: { message: "PRIVATE_DATABASE_DETAIL" },
        });
        return;
      }
      const table = url.pathname.split("/").at(-1);
      if (method === "GET") {
        if (table === "profiles")
          await route.fulfill({
            json: {
              id: user.id,
              display_name: state.name,
              preferences: state.preferences,
            },
          });
        else if (table === "favorites")
          await route.fulfill({
            json: state.favorites.map((poi_id) => ({ poi_id })),
          });
        else if (table === "saved_walks")
          await route.fulfill({ json: state.walks });
        else await route.abort();
        return;
      }
      const body = request.postData()
        ? (request.postDataJSON() as Record<string, unknown>)
        : {};
      state.mutations.push({ table, method, ...body });
      if (table === "favorites") {
        if (
          method === "POST" &&
          typeof body.poi_id === "string" &&
          !state.favorites.includes(body.poi_id)
        )
          state.favorites.push(body.poi_id);
        if (method === "DELETE")
          state.favorites = state.favorites.filter(
            (id) => url.searchParams.get("poi_id") !== `eq.${id}`,
          );
        await route.fulfill({ status: 201, json: [] });
        return;
      }
      if (table === "saved_walks") {
        if (method === "POST") {
          const saved = {
            ...body,
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            created_at: "2026-10-17T05:00:00Z",
            updated_at: "2026-10-17T05:00:00Z",
          } as SavedRecord;
          state.walks.push(saved);
          await route.fulfill({ status: 201, json: saved });
          return;
        }
        if (method === "PATCH")
          state.walks = state.walks.map((walk) =>
            url.searchParams.get("id") === `eq.${walk.id}`
              ? { ...walk, title: String(body.title) }
              : walk,
          );
        if (method === "DELETE")
          state.walks = state.walks.filter(
            (walk) => url.searchParams.get("id") !== `eq.${walk.id}`,
          );
        await route.fulfill({ status: 204 });
        return;
      }
      if (table === "profiles") {
        if (typeof body.display_name === "string")
          state.name = body.display_name;
        if (body.preferences)
          state.preferences = body.preferences as Record<string, unknown>;
        await route.fulfill({ status: 204 });
        return;
      }
      if (table === "aitu_delete_my_personal_data") {
        state.favorites = [];
        state.walks = [];
        state.name = "";
        await route.fulfill({ status: 204 });
        return;
      }
    }
    await route.abort();
  });
  return state;
}

async function signIn(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(user.email);
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("Only-for-tests-124!");
  await dialog.getByRole("button", { name: "Войти", exact: true }).click();
}

test.beforeEach(async ({ page }) => stubTiles(page));

test("guest favorite resumes after sign-in, restores after reload, and logout leaves guest search usable", async ({
  page,
}) => {
  const state = await mockAccount(page);
  await page.goto("/");
  await page.getByLabel("Чего хочется сегодня?").fill("Хочу погулять");
  await search(page);
  const card = page.getByTestId("result-card").first();
  const title = await card.locator("h3").innerText();
  const favorite = card.getByRole("button", { name: /^В избранное/ });
  await favorite.click();
  await signIn(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: /^Убрать из избранного/ }),
  ).toBeVisible();
  await expect(card).toContainText(title);
  expect(state.signIns).toBe(1);
  expect(state.favorites).toHaveLength(1);
  await page.reload();
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".account-row").first()).toContainText(title);
  await dialog.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Войти", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await search(page);
  await expect(page.getByTestId("result-card").first()).toBeVisible();
  await expect(page.locator(".account-button")).toHaveAccessibleName("Войти");
});

test("saved selections contain preferences but no coordinates or chat, and can be renamed and deleted", async ({
  page,
}) => {
  const state = await mockAccount(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await signIn(page);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Профиль", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await search(page);
  await page
    .getByRole("button", { name: "Сохранить подборку", exact: true })
    .click();
  await expect.poll(() => state.walks.length).toBe(1);
  expect(state.walks[0].ordered_poi_ids.length).toBeGreaterThan(0);
  expect(state.walks[0].user_preferences).toHaveProperty(
    "duration_minutes",
    60,
  );
  const body = state.mutations.find(
    (item) => item.table === "saved_walks" && item.method === "POST",
  )!;
  for (const forbidden of [
    "origin",
    "lat",
    "lon",
    "geometry",
    "query",
    "messages",
  ])
    expect(JSON.stringify(body)).not.toContain(`"${forbidden}"`);
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const row = dialog
    .locator(".account-row")
    .filter({
      has: page.getByRole("button", { name: "Открыть прогулку", exact: true }),
    });
  await row.getByRole("button", { name: "Переименовать", exact: true }).click();
  await row
    .getByLabel("Название прогулки", { exact: true })
    .fill("Вечерняя прогулка");
  await row.getByRole("button", { name: "Переименовать", exact: true }).click();
  await expect(row.locator("strong")).toHaveText("Вечерняя прогулка");
  await row.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(state.walks).toHaveLength(0);
});

test("signup validates confirmation and reports email confirmation without inventing a session", async ({
  page,
}) => {
  const state = await mockAccount(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Зарегистрироваться", exact: true })
    .click();
  await dialog.getByLabel("Email", { exact: true }).fill(user.email);
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("Only-for-tests-124!");
  await dialog
    .getByLabel("Повторите пароль", { exact: true })
    .fill("Wrong-test-password!");
  await dialog
    .getByRole("button", { name: "Зарегистрироваться", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Пароли не совпадают");
  expect(state.signUps).toBe(0);
  await dialog
    .getByLabel("Повторите пароль", { exact: true })
    .fill("Only-for-tests-124!");
  await dialog
    .getByRole("button", { name: "Зарегистрироваться", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Проверьте почту и подтвердите email",
  );
  expect(state.signUps).toBe(1);
  await expect(page.locator(".account-button")).toHaveAccessibleName("Войти");
});

test("recovery remains non-enumerating and a recovery return allows a password update", async ({
  page,
}) => {
  const state = await mockAccount(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Забыли пароль?", exact: true })
    .click();
  await dialog.getByLabel("Email", { exact: true }).fill(user.email);
  await dialog
    .getByRole("button", { name: "Отправить ссылку", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Если аккаунт с этим email существует",
  );
  expect(state.recoveries).toBe(1);
  await page.evaluate(
    (value) =>
      localStorage.setItem("sb-aitu-test-auth-token", JSON.stringify(value)),
    session(),
  );
  await page.goto("/?auth=recovery");
  await expect(
    dialog.getByRole("heading", {
      name: "Установить новый пароль",
      exact: true,
    }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await expect(
    dialog.getByRole("heading", {
      name: "Установить новый пароль",
      exact: true,
    }),
  ).toBeVisible();
  await page.reload();
  await expect(
    dialog.getByRole("heading", {
      name: "Установить новый пароль",
      exact: true,
    }),
  ).toBeVisible();
  await dialog
    .getByLabel("Новый пароль", { exact: true })
    .fill("New-only-for-tests-123!");
  await dialog
    .getByLabel("Повторите пароль", { exact: true })
    .fill("New-only-for-tests-123!");
  await dialog
    .getByRole("button", { name: "Установить новый пароль", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Пароль обновлён");
  expect(new URL(page.url()).searchParams.has("auth")).toBe(false);
});

test("auth errors are sanitized and duplicate submit cannot send a second request", async ({
  page,
}) => {
  const state = await mockAccount(page, {
    invalidLogin: true,
    delayLogin: true,
  });
  await page.goto("/");
  await search(page);
  await page
    .getByTestId("result-card")
    .first()
    .getByRole("button", { name: /^В избранное/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Email", { exact: true }).fill(user.email);
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("Only-for-tests-124!");
  await dialog.getByLabel("Пароль", { exact: true }).press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Подождите…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("alert")).toContainText(
    "Не удалось войти. Проверьте email и пароль",
  );
  expect(state.signIns).toBe(1);
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE_PROVIDER_DETAIL",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("result-card").first()).toBeVisible();
});

test("private-data outage can be retried and a vanished favorite remains removable", async ({
  page,
}) => {
  const state = await mockAccount(page, {
    failData: true,
    favorites: ["node/999999"],
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await signIn(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toContainText(
    "Не удалось загрузить сохранения",
  );
  await expect(page.locator("body")).not.toContainText(
    "PRIVATE_DATABASE_DETAIL",
  );
  state.failData = false;
  await dialog
    .getByRole("button", { name: "Обновить сохранения", exact: true })
    .click();
  await expect(dialog.locator(".account-row")).toContainText(
    "Место больше не доступно в городской базе",
  );
  await dialog
    .getByRole("button", { name: "Убрать из избранного", exact: true })
    .click();
  await expect(dialog.locator(".account-row")).toHaveCount(0);
});

test("auth dialog traps keyboard focus and Escape restores its trigger", async ({
  page,
}) => {
  await mockAccount(page);
  await page.goto("/");
  const opener = page.getByRole("button", { name: "Войти", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog");
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("saved preferences survive reload but apply only after an explicit action", async ({
  page,
}) => {
  const state = await mockAccount(page);
  await page.goto("/");
  await page.getByRole("button", { name: /^Подобрать прогулку/ }).click();
  await page.getByRole("button", { name: "2 часа", exact: true }).click();
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await signIn(page);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Сохранить текущие настройки", exact: true })
    .click();
  await expect.poll(() => state.preferences.duration_minutes).toBe(120);
  await page.reload();
  await expect(page.locator(".search-context")).toContainText("60 мин");
  await page.getByRole("button", { name: "Профиль", exact: true }).click();
  await dialog
    .getByRole("button", {
      name: "Применить сохранённые настройки",
      exact: true,
    })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".search-context")).toContainText("120 мин");
});

test("personal-data deletion requires a separate confirmation and preserves the account", async ({
  page,
}) => {
  const state = await mockAccount(page, { favorites: ["node/1"] });
  await page.goto("/");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await signIn(page);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".account-row")).toHaveCount(1);
  await dialog
    .getByRole("button", {
      name: "Удалить мои сохранённые данные",
      exact: true,
    })
    .click();
  expect(
    state.mutations.filter(
      (item) => item.table === "aitu_delete_my_personal_data",
    ),
  ).toHaveLength(0);
  await dialog
    .getByRole("button", { name: "Удалить данные безвозвратно", exact: true })
    .click();
  await expect(dialog.locator(".account-row")).toHaveCount(0);
  await expect(dialog.getByRole("status")).toContainText(
    "Аккаунт для входа остаётся активным",
  );
  await expect(
    dialog.getByRole("button", { name: "Выйти", exact: true }),
  ).toBeVisible();
  expect(
    state.mutations.filter(
      (item) => item.table === "aitu_delete_my_personal_data",
    ),
  ).toHaveLength(1);
});
