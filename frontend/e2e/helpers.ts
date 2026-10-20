import { expect, type Page } from "@playwright/test";

export async function stubTiles(page: Page) {
  // Repeated browser tests never request OSM tiles or use the production DB.
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e5e9dc"/></svg>',
    }),
  );
}

export async function openConditions(page: Page) {
  const disclosure = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Уточнить условия" }),
  });
  if (
    (await disclosure.count()) &&
    !(await disclosure.evaluate((element) => element.hasAttribute("open")))
  ) {
    await disclosure.locator(":scope > summary").click();
  }
}

export async function chooseOrigin(page: Page, name = "Fixture Park") {
  await page
    .getByRole("button", { name: "Изменить точку старта", exact: true })
    .first()
    .click();
  await page.locator(".location-search input").fill(name);
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".start-value:visible strong").first()).toHaveText(
    name,
  );
}

export async function search(page: Page) {
  await page
    .getByRole("button", { name: /^(Найти место|Подобрать места)$/ })
    .click();
  await expect(page.locator(".results-title")).toBeVisible();
}

export async function backFromMap(page: Page) {
  await page
    .getByRole("button", { name: /Вернуться к (результатам|диалогу)/ })
    .click();
}

export async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
