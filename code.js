// Universal RTL Converter Plugin v2
// Works with any Figma design — uses Gemini API for translation
// Fixes: deep fixed-position mirroring, Gemini model fallback + retry

const STORAGE_KEY = "rtl-converter-gemini-key";

// Gemini models to try in order (fallback chain)
const GEMINI_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-flash-8b",
];

// ============================================================
// Show UI
// ============================================================
figma.showUI(__html__, { width: 340, height: 580 });

async function loadSavedKey() {
  try {
    const key = await figma.clientStorage.getAsync(STORAGE_KEY);
    if (key) {
      figma.ui.postMessage({ type: "key-loaded", key });
    }
  } catch (e) {}
}
loadSavedKey();

// ============================================================
// Handle messages from UI
// ============================================================
figma.ui.onmessage = async (msg) => {
  if (msg.type === "save-key") {
    await figma.clientStorage.setAsync(STORAGE_KEY, msg.key);
    figma.notify("API key saved!");
  }

  if (msg.type === "scan") {
    await scanCurrentPage();
  }

  if (msg.type === "convert") {
    await convertToRTL(msg.apiKey, msg.targetLang, msg.fontFamily, msg.texts);
  }
};

// ============================================================
// SCAN: Analyze current page
// ============================================================
async function scanCurrentPage() {
  const page = figma.currentPage;

  const textNodes = page.findAll((n) => n.type === "TEXT");
  const allTexts = [];
  const uniqueTexts = new Set();

  for (const node of textNodes) {
    const text = node.characters.trim();
    if (text && text.length > 0) {
      allTexts.push(text);
      uniqueTexts.add(text);
    }
  }

  const layouts = page.findAll(
    (n) =>
      (n.type === "FRAME" || n.type === "COMPONENT") &&
      n.layoutMode &&
      n.layoutMode !== "NONE"
  );

  let frameCount = 0;
  for (const child of page.children) {
    if (child.type === "FRAME" || child.type === "SECTION" || child.type === "COMPONENT") {
      frameCount++;
    }
  }

  figma.ui.postMessage({
    type: "scan-result",
    pageName: page.name,
    frameCount,
    totalTexts: allTexts.length,
    uniqueTexts: uniqueTexts.size,
    layoutCount: layouts.length,
    texts: [...uniqueTexts],
  });
}

// ============================================================
// HELPER: Sleep for delay
// ============================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// TRANSLATE: Call Gemini API with retry + model fallback
// ============================================================
async function translateWithGemini(apiKey, texts, targetLang) {
  const langNames = {
    ar: "Arabic",
    he: "Hebrew",
    fa: "Persian",
    ur: "Urdu",
  };
  const langName = langNames[targetLang] || "Arabic";

  const BATCH_SIZE = 50;
  const allTranslations = {};
  let workingModel = null; // Cache the model that works

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE);

    figma.ui.postMessage({
      type: "progress",
      percent: Math.round((i / texts.length) * 40),
      message: `Translating batch ${batchNum}/${totalBatches}...`,
    });

    const prompt = `You are a professional UI/UX translator. Translate these user interface strings to ${langName}.

RULES:
- Return ONLY valid JSON object, no markdown, no explanation
- Keep numbers as standard digits (123), NOT ${langName} numerals
- Keep proper nouns, brand names, and email addresses unchanged
- Keep date formats readable in ${langName}
- Translations should be natural and concise for mobile UI
- If a string is already in ${langName}, return it as-is
- Maintain line breaks if present in the original

INPUT:
${JSON.stringify(batch)}

OUTPUT (JSON object mapping each input string to its ${langName} translation):`;

    // Try models in order, with retry on 429
    const modelsToTry = workingModel ? [workingModel] : GEMINI_MODELS;
    let success = false;

    for (const model of modelsToTry) {
      if (success) break;

      // Retry up to 3 times per model (for rate limits)
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          figma.ui.postMessage({
            type: "log",
            message: `Trying ${model} (attempt ${attempt})...`,
            logType: "info",
          });

          const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                  temperature: 0.1,
                  responseMimeType: "application/json",
                },
              }),
            }
          );

          if (response.status === 429) {
            // Rate limited — extract retry delay or default to 30s
            const errorBody = await response.text();
            let retryDelay = 30;
            const delayMatch = errorBody.match(/retryDelay.*?(\d+)/);
            if (delayMatch) {
              retryDelay = Math.min(parseInt(delayMatch[1]) + 5, 60);
            }

            if (attempt < 3) {
              figma.ui.postMessage({
                type: "log",
                message: `Rate limited on ${model}. Waiting ${retryDelay}s before retry...`,
                logType: "error",
              });
              await sleep(retryDelay * 1000);
              continue; // Retry same model
            } else {
              figma.ui.postMessage({
                type: "log",
                message: `${model}: 3 retries exhausted. Trying next model...`,
                logType: "error",
              });
              break; // Try next model
            }
          }

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`${model} error ${response.status}: ${errorText.substring(0, 200)}`);
          }

          const data = await response.json();
          const content = data.candidates[0].content.parts[0].text;

          let parsed;
          try {
            parsed = JSON.parse(content);
          } catch (e) {
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              parsed = JSON.parse(jsonMatch[0]);
            } else {
              throw new Error("Could not parse Gemini response as JSON");
            }
          }

          Object.assign(allTranslations, parsed);
          workingModel = model; // Cache working model
          success = true;

          figma.ui.postMessage({
            type: "log",
            message: `Batch ${batchNum}: translated ${Object.keys(parsed).length} strings via ${model}`,
            logType: "success",
          });

          break; // Success, exit retry loop

        } catch (e) {
          if (attempt === 3) {
            figma.ui.postMessage({
              type: "log",
              message: `${model}: ${e.message}`,
              logType: "error",
            });
          }
        }
      }
    }

    if (!success) {
      figma.ui.postMessage({
        type: "log",
        message: `Batch ${batchNum}: ALL models failed. Skipping batch.`,
        logType: "error",
      });
    }

    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < texts.length) {
      await sleep(2000);
    }
  }

  return allTranslations;
}

// ============================================================
// LOAD FONT
// ============================================================
async function loadTargetFont(fontFamily) {
  const styles = ["Regular", "Bold", "Medium", "SemiBold", "Light"];
  const loaded = {};

  for (const style of styles) {
    try {
      await figma.loadFontAsync({ family: fontFamily, style });
      loaded[style] = { family: fontFamily, style };
    } catch (e) {}
  }

  return loaded;
}

function getTargetFontForWeight(originalFont, availableFonts) {
  const style = originalFont.style || "Regular";
  if (style.includes("Bold") && availableFonts["Bold"]) return availableFonts["Bold"];
  if (style.includes("SemiBold") && availableFonts["SemiBold"]) return availableFonts["SemiBold"];
  if (style.includes("Semi Bold") && availableFonts["SemiBold"]) return availableFonts["SemiBold"];
  if (style.includes("Medium") && availableFonts["Medium"]) return availableFonts["Medium"];
  if (style.includes("Light") && availableFonts["Light"]) return availableFonts["Light"];
  if (availableFonts["Regular"]) return availableFonts["Regular"];
  const keys = Object.keys(availableFonts);
  return keys.length > 0 ? availableFonts[keys[0]] : null;
}

// ============================================================
// APPLY TRANSLATIONS
// ============================================================
async function applyTranslations(page, translations, availableFonts) {
  const textNodes = page.findAll((n) => n.type === "TEXT");
  let translated = 0;

  for (const node of textNodes) {
    const original = node.characters.trim();

    let target = translations[original];
    if (!target) {
      const normalized = original.replace(/\s+/g, " ").trim();
      target = translations[normalized];
    }

    if (target && target !== original) {
      try {
        if (node.fontName !== figma.mixed) {
          await figma.loadFontAsync(node.fontName);
        } else {
          const len = node.characters.length;
          const fontsToLoad = new Set();
          for (let i = 0; i < len; i++) {
            const font = node.getRangeFontName(i, i + 1);
            if (font !== figma.mixed) fontsToLoad.add(JSON.stringify(font));
          }
          for (const fontStr of fontsToLoad) {
            await figma.loadFontAsync(JSON.parse(fontStr));
          }
        }

        const originalFont =
          node.fontName !== figma.mixed
            ? node.fontName
            : { family: "Inter", style: "Regular" };

        const originalResize = node.textAutoResize;

        node.characters = target;

        const targetFont = getTargetFontForWeight(originalFont, availableFonts);
        if (targetFont) {
          node.fontName = targetFont;
        }

        node.textAlignHorizontal = "RIGHT";

        if (originalResize === "NONE") {
          node.textAutoResize = "HEIGHT";
        }

        translated++;
      } catch (e) {
        console.warn(`Failed: "${original}": ${e.message}`);
      }
    }
  }

  return translated;
}

// ============================================================
// RIGHT ALIGN ALL TEXT
// ============================================================
async function rightAlignAllText(page) {
  const textNodes = page.findAll((n) => n.type === "TEXT");
  let count = 0;

  for (const node of textNodes) {
    try {
      if (node.fontName !== figma.mixed) {
        await figma.loadFontAsync(node.fontName);
      } else {
        const len = node.characters.length;
        const fontsToLoad = new Set();
        for (let i = 0; i < len; i++) {
          const font = node.getRangeFontName(i, i + 1);
          if (font !== figma.mixed) fontsToLoad.add(JSON.stringify(font));
        }
        for (const fontStr of fontsToLoad) {
          await figma.loadFontAsync(JSON.parse(fontStr));
        }
      }
      node.textAlignHorizontal = "RIGHT";
      count++;
    } catch (e) {}
  }

  return count;
}

// ============================================================
// MIRROR RTL: Deep recursive for auto layouts
// ============================================================
function mirrorHorizontalLayouts(root) {
  let mirrored = 0;

  function walk(node) {
    if (!("children" in node)) return;
    if (node.type === "INSTANCE") return;

    try {
      if (node.layoutMode === "HORIZONTAL") {
        const children = [...node.children];
        if (children.length > 1) {
          for (let i = children.length - 1; i >= 0; i--) {
            node.appendChild(children[i]);
          }
          mirrored++;
        }
      }

      if (node.layoutMode === "VERTICAL") {
        if (node.counterAxisAlignItems === "MIN") {
          node.counterAxisAlignItems = "MAX";
        }
      }
    } catch (e) {}

    // Always recurse into children
    for (const child of [...node.children]) {
      walk(child);
    }
  }

  for (const child of root.children) {
    walk(child);
  }

  return mirrored;
}

// ============================================================
// MIRROR FIXED POSITIONS: Deep recursive into ALL frames
// Even if parent has auto layout, still recurse into children
// that might have fixed-position (no auto layout) frames
// ============================================================
function mirrorFixedPositions(root) {
  let mirrored = 0;

  function walk(node) {
    if (!("children" in node)) return;
    if (node.type === "INSTANCE") return;

    // If THIS node has no auto layout, mirror its children's x positions
    if (!node.layoutMode || node.layoutMode === "NONE") {
      const pw = node.width;
      if (pw > 0) {
        for (const child of node.children) {
          try {
            const newX = pw - child.x - child.width;
            if (Math.abs(newX - child.x) > 0.5) {
              child.x = newX;
              mirrored++;
            }
          } catch (e) {}
        }
      }
    }

    // ALWAYS recurse into ALL children regardless of parent layout mode
    // This is the key fix — before we skipped children of auto-layout parents
    for (const child of [...node.children]) {
      if ("children" in child && child.type !== "INSTANCE") {
        walk(child);
      }
    }
  }

  for (const child of root.children) {
    walk(child);
  }

  return mirrored;
}

// ============================================================
// MAIN CONVERT FLOW
// ============================================================
async function convertToRTL(apiKey, targetLang, fontFamily, texts) {
  const page = figma.currentPage;

  try {
    // Step 1: Translate with Gemini
    figma.ui.postMessage({
      type: "progress",
      percent: 5,
      message: "Sending texts to Gemini for translation...",
    });

    const translations = await translateWithGemini(apiKey, texts, targetLang);
    const translatedCount = Object.keys(translations).length;

    figma.ui.postMessage({
      type: "log",
      message: `Gemini returned ${translatedCount} translations`,
      logType: "success",
    });

    // Step 2: Load target font
    figma.ui.postMessage({
      type: "progress",
      percent: 45,
      message: `Loading ${fontFamily} font...`,
    });

    const availableFonts = await loadTargetFont(fontFamily);
    const fontCount = Object.keys(availableFonts).length;

    if (fontCount === 0) {
      figma.ui.postMessage({
        type: "error",
        message: `Could not load ${fontFamily}. Please install it first.`,
      });
      return;
    }

    figma.ui.postMessage({
      type: "log",
      message: `Loaded ${fontCount} font weights for ${fontFamily}`,
      logType: "info",
    });

    // Step 3: Apply translations
    figma.ui.postMessage({
      type: "progress",
      percent: 55,
      message: "Applying translations...",
    });

    const translated = await applyTranslations(page, translations, availableFonts);

    figma.ui.postMessage({
      type: "log",
      message: `Applied ${translated} translations`,
      logType: "success",
    });

    // Step 4: Right-align all text
    figma.ui.postMessage({
      type: "progress",
      percent: 70,
      message: "Setting right alignment...",
    });

    const aligned = await rightAlignAllText(page);

    figma.ui.postMessage({
      type: "log",
      message: `Right-aligned ${aligned} text nodes`,
      logType: "info",
    });

    // Step 5: Mirror horizontal layouts
    figma.ui.postMessage({
      type: "progress",
      percent: 80,
      message: "Mirroring horizontal layouts...",
    });

    const mirroredLayouts = mirrorHorizontalLayouts(page);

    figma.ui.postMessage({
      type: "log",
      message: `Reversed ${mirroredLayouts} horizontal layouts`,
      logType: "success",
    });

    // Step 6: Mirror fixed positions (deep)
    figma.ui.postMessage({
      type: "progress",
      percent: 90,
      message: "Mirroring fixed positions...",
    });

    const mirroredFixed = mirrorFixedPositions(page);

    figma.ui.postMessage({
      type: "log",
      message: `Mirrored ${mirroredFixed} fixed elements`,
      logType: "success",
    });

    // Done
    figma.ui.postMessage({
      type: "done",
      translated,
      mirrored: mirroredLayouts + mirroredFixed,
    });

    figma.notify(
      `RTL conversion complete! Translated: ${translated}, Mirrored: ${mirroredLayouts + mirroredFixed}`,
      { timeout: 5000 }
    );
  } catch (e) {
    figma.ui.postMessage({
      type: "error",
      message: e.message,
    });
    figma.notify("Error: " + e.message, { error: true });
  }
}
