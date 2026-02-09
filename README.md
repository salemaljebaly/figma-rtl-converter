# RTL Converter - Universal (Figma Plugin)

Simple Figma plugin to convert a page from LTR to RTL by:
- translating text with Gemini API
- applying RTL-friendly text alignment
- mirroring horizontal auto-layouts
- mirroring fixed-position elements recursively

## Project Structure

- `manifest.json`: Figma plugin manifest
- `code.js`: plugin logic (scan, translate, mirror, apply fonts)
- `ui.html`: plugin UI

## Features

- Scans current page and extracts unique text strings
- Translates in batches with Gemini model fallback/retry
- Supports target languages:
  - Arabic (`ar`)
- Applies selected Arabic font (Tajawal, Cairo, Noto Sans Arabic, IBM Plex Sans Arabic)
- Right-aligns text nodes
- Mirrors layouts for RTL behavior

## Requirements

- Figma desktop app (or plugin development in Figma)
- Gemini API key
- Internet access to:
  - `https://generativelanguage.googleapis.com`
- Target fonts installed in Figma/system

## Run Locally

1. Open Figma.
2. Go to `Plugins` -> `Development` -> `Import plugin from manifest...`.
3. Select this project's `manifest.json`.
4. Run the plugin from `Plugins` -> `Development` -> `RTL Converter - Universal`.

## Usage

1. Paste your Gemini API key in the plugin UI and save it.
2. Click **Scan Current Page**.
3. Choose target language and font.
4. Click **Convert to RTL**.
5. Wait for progress logs and completion message.

## Notes

- The plugin processes the current page only.
- Large pages may take longer due to translation batching and rate-limit retries.
- If selected font cannot be loaded, conversion stops with an error.
