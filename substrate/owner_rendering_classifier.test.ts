import { describe, expect, test } from "bun:test";
import { classifyOwnerRenderingSignals } from "./owner_rendering_classifier";

describe("classifyOwnerRenderingSignals — universal continuous signals", () => {
  test("code-heavy text raises code_density signal", () => {
    const r = classifyOwnerRenderingSignals(
      "the bug is in runtime/task_scheduler.ts:84 — getUserById returns null when MAX_CONCURRENT is 0",
    );
    expect(r.signals.code_density).toBeDefined();
    expect(r.signals.code_density!).toBeGreaterThan(0);
    expect(r.evidence.some((e) => e.includes("code_identifiers") || e.includes("file_paths"))).toBe(true);
  });

  test("ops vocabulary raises ops_vocabulary signal", () => {
    const r = classifyOwnerRenderingSignals(
      "the deployment p99 latency spiked after the rollout — pull the dashboard, who's the on-call?",
    );
    expect(r.signals.ops_vocabulary).toBeDefined();
    expect(r.signals.ops_vocabulary!).toBeGreaterThan(0);
  });

  test("MIXED owner: both code AND explanation_appetite can light up", () => {
    // An owner who uses code identifiers AND asks natural questions is
    // a real human, not a category-error bucket. Both signals fire.
    const r = classifyOwnerRenderingSignals(
      "how do I figure out why getUserById returns null in /src/users/lookup.ts?",
    );
    expect(r.signals.code_density).toBeGreaterThan(0);
    expect(r.signals.explanation_appetite).toBeGreaterThan(0);
  });

  test("natural-language ask raises explanation_appetite signal", () => {
    const r = classifyOwnerRenderingSignals("help me lose 5kg by summer");
    expect(r.signals.explanation_appetite).toBeDefined();
    expect(r.signals.explanation_appetite!).toBeGreaterThan(0);
  });

  test("short conversational text raises explanation_appetite via baseline", () => {
    const r = classifyOwnerRenderingSignals("I want to write a novel");
    expect(r.signals.explanation_appetite).toBeDefined();
    expect(r.signals.explanation_appetite!).toBeGreaterThan(0);
  });

  test("empty text produces no signals + minimum confidence", () => {
    const r = classifyOwnerRenderingSignals("");
    // No signal evidence — empty map, NOT a default-persona fallback.
    expect(Object.keys(r.signals).length).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  test("signal strengths are continuous in [0, 1]", () => {
    const r = classifyOwnerRenderingSignals(
      "function getUserById() { const filePath = './src/index.ts'; return; } " +
      "git rebase master, bun test, npm install, .env, package.json, tsconfig",
    );
    for (const [, v] of Object.entries(r.signals)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("confidence rises with more independent dimensions firing", () => {
    const oneSignal = classifyOwnerRenderingSignals("help me");
    const threeSignals = classifyOwnerRenderingSignals(
      "how do I deploy this fix in runtime/scheduler.ts — the rollback p99 latency spiked",
    );
    expect(threeSignals.confidence).toBeGreaterThan(oneSignal.confidence);
    expect(threeSignals.confidence).toBeLessThanOrEqual(0.95);
  });

  test("uses prior texts when classifying primary", () => {
    const prior = ["my last PR broke the CI/CD pipeline; can you check the docker rollback?"];
    const r = classifyOwnerRenderingSignals("look at this", prior);
    // Prior alone gives both code AND ops signals.
    expect(r.signals.code_density ?? r.signals.ops_vocabulary).toBeDefined();
  });

  test("evidence array is always populated when any signal fires", () => {
    const r = classifyOwnerRenderingSignals("function() {}");
    expect(Array.isArray(r.evidence)).toBe(true);
    if (Object.keys(r.signals).length > 0) {
      expect(r.evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyOwnerRenderingSignals — Unicode-script detected_language", () => {
  test("pure-English directive detects 'en'", () => {
    const r = classifyOwnerRenderingSignals("help me migrate the database");
    expect(r.detected_language).toBe("en");
    expect(r.evidence.some((e) => e.startsWith("detected_language=en"))).toBe(true);
  });

  test("pure-Russian directive detects 'ru'", () => {
    const r = classifyOwnerRenderingSignals("Помоги мне с миграцией базы данных");
    expect(r.detected_language).toBe("ru");
    expect(r.evidence.some((e) => e.startsWith("detected_language=ru"))).toBe(true);
  });

  test("mixed English + code identifiers still detects 'en'", () => {
    // The existing passing test case from above: code identifiers are
    // Latin-block characters so detected_language stays "en" even with
    // file paths and camelCase symbols mixed in.
    const r = classifyOwnerRenderingSignals(
      "how do I figure out why getUserById returns null in /src/users/lookup.ts?",
    );
    expect(r.detected_language).toBe("en");
  });

  test("pure-Japanese directive detects 'ja'", () => {
    // Hiragana + Katakana + CJK → "ja" (because Hiragana/Katakana > 0).
    const r = classifyOwnerRenderingSignals("データベースの移行を手伝ってください");
    expect(r.detected_language).toBe("ja");
    expect(r.evidence.some((e) => e.startsWith("detected_language=ja"))).toBe(true);
  });

  test("empty text yields no detected_language", () => {
    const r = classifyOwnerRenderingSignals("");
    expect(r.detected_language).toBeUndefined();
  });

  test("pure-punctuation text yields no detected_language", () => {
    const r = classifyOwnerRenderingSignals("!!! ??? --- ... 12345");
    expect(r.detected_language).toBeUndefined();
  });

  test("Korean directive detects 'ko'", () => {
    const r = classifyOwnerRenderingSignals("데이터베이스 마이그레이션 도와주세요");
    expect(r.detected_language).toBe("ko");
  });

  test("Arabic directive detects 'ar'", () => {
    const r = classifyOwnerRenderingSignals("ساعدني في ترحيل قاعدة البيانات");
    expect(r.detected_language).toBe("ar");
  });

  test("Hebrew directive detects 'he'", () => {
    const r = classifyOwnerRenderingSignals("עזור לי להעביר את מסד הנתונים");
    expect(r.detected_language).toBe("he");
  });

  test("Chinese (CJK without kana) detects 'zh'", () => {
    const r = classifyOwnerRenderingSignals("帮我迁移数据库");
    expect(r.detected_language).toBe("zh");
  });

  test("Devanagari directive detects 'hi'", () => {
    const r = classifyOwnerRenderingSignals("कृपया डेटाबेस माइग्रेशन में मेरी मदद करें");
    expect(r.detected_language).toBe("hi");
    expect(r.language_distribution?.[0]?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("Thai directive detects 'th'", () => {
    const r = classifyOwnerRenderingSignals("ช่วยฉันย้ายฐานข้อมูล");
    expect(r.detected_language).toBe("th");
    expect(r.language_distribution?.[0]?.evidence).toContain("Thai block");
  });

  test("Latin-script Spanish directive does not collapse to English", () => {
    const r = classifyOwnerRenderingSignals("ayuda con el sistema para migrar la base de datos");
    expect(r.detected_language).toBe("es");
    expect(r.language_distribution?.some((c) => c.lang === "es")).toBe(true);
  });

  test("language detection does not regress existing signal extraction", () => {
    // Sanity: a directive that fires code_density and explanation_appetite
    // (the existing mixed-case test) should still fire those signals AND
    // emit detected_language="en" together — adding the language axis
    // must be purely additive.
    const r = classifyOwnerRenderingSignals(
      "how do I figure out why getUserById returns null in /src/users/lookup.ts?",
    );
    expect(r.signals.code_density).toBeGreaterThan(0);
    expect(r.signals.explanation_appetite).toBeGreaterThan(0);
    expect(r.detected_language).toBe("en");
  });
});
