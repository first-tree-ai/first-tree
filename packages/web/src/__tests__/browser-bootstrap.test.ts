import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const indexHtmlUrl = new URL("../../index.html", import.meta.url);
const bootstrapUrl = new URL("../../public/browser-bootstrap.js", import.meta.url);

type BootstrapResult = {
  appendedScriptSources: string[];
  darkClassAdded: ReturnType<typeof vi.fn>;
  windowObject: Record<string, unknown>;
};

async function runBootstrap(options: {
  hostname: string;
  theme: string | null;
  prefersDark: boolean;
}): Promise<BootstrapResult> {
  const source = await readFile(bootstrapUrl, "utf8");
  const appendedScriptSources: string[] = [];
  const darkClassAdded = vi.fn();
  const windowObject: Record<string, unknown> = {
    location: { hostname: options.hostname },
    matchMedia: vi.fn(() => ({ matches: options.prefersDark })),
  };
  const documentObject = {
    createElement: vi.fn(() => ({ async: false, src: "" })),
    documentElement: { classList: { add: darkClassAdded } },
    head: {
      appendChild: vi.fn((tag: { src: string }) => {
        appendedScriptSources.push(tag.src);
      }),
    },
  };
  const localStorageObject = { getItem: vi.fn(() => options.theme) };

  runInNewContext(source, {
    document: documentObject,
    localStorage: localStorageObject,
    window: windowObject,
  });

  return { appendedScriptSources, darkClassAdded, windowObject };
}

describe("browser bootstrap", () => {
  it("keeps index.html free of inline executable scripts", async () => {
    const indexHtml = await readFile(indexHtmlUrl, "utf8");
    const scripts = Array.from(indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)).map((match) => ({
      attributes: match[1] ?? "",
      body: match[2] ?? "",
    }));

    expect(scripts.map((script) => script.attributes.match(/\bsrc="([^"]+)"/u)?.[1])).toEqual([
      "/browser-bootstrap.js",
      "/src/main.tsx",
    ]);
    expect(scripts.every((script) => script.body.trim().length === 0)).toBe(true);
  });

  it("loads production analytics and preserves the gtag queue contract", async () => {
    const result = await runBootstrap({ hostname: "cloud.first-tree.ai", theme: "dark", prefersDark: false });

    expect(result.appendedScriptSources).toEqual([
      "https://www.googletagmanager.com/gtag/js?id=G-BHG918MZ02",
      "https://www.clarity.ms/tag/xj2f9syfng",
    ]);
    expect(result.windowObject.dataLayer).toHaveLength(2);
    expect(result.windowObject.gtag).toBeTypeOf("function");
    expect(result.windowObject.clarity).toBeTypeOf("function");
    expect(result.darkClassAdded).toHaveBeenCalledWith("dark");
  });

  it("does not initialize production analytics on staging or local hosts", async () => {
    const result = await runBootstrap({ hostname: "dev.cloud.first-tree.ai", theme: null, prefersDark: true });

    expect(result.appendedScriptSources).toEqual([]);
    expect(result.windowObject.dataLayer).toBeUndefined();
    expect(result.windowObject.gtag).toBeUndefined();
    expect(result.windowObject.clarity).toBeUndefined();
    expect(result.darkClassAdded).toHaveBeenCalledWith("dark");
  });
});
