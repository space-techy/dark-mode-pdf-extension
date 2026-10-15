# Lumen PDF

A browser extension for reading PDFs comfortably. It opens PDFs in its own viewer and recolours them with eye-friendly themes. Photos and figures keep their real colours. You can also download the themed version as a new PDF.

Works in Chrome, Edge, Brave, Opera, Firefox and Safari.

## Features

- **12 reading themes**: Dark, OLED Black, Warm Night, Ember (low blue light), Slate, Forest, Deep Ocean, Sepia, Soft Paper, Sage, High Contrast and Original.
- **Your own themes**: pick any background and text colour. The page updates as you pick, and you can save as many named themes as you like.
- **Images stay natural**: real images are found in the PDF's drawing instructions and left out of the recolouring, so they never get inverted. An image-brightness slider lets you dim them for night reading. Scanned pages, which are one big image, are detected and themed like text.
- **Coloured text keeps its colour**: red stays red and links stay blue. Only the lightness is flipped.
- **Download themed PDF**, in any theme:
  - *Crisp*: the original PDF is re-coloured with standard PDF blend modes. Text stays sharp, selectable and searchable, and the file stays small.
  - *Exact*: every page is captured as it looks on screen, at 150 or 220 dpi. Use this for locked or encrypted PDFs.
- **Fast**: only the pages near the screen are rendered. Changing the theme reuses those renders, so there is no re-render and no white flash. Placeholder pages already use the theme colour.
- **A complete reader**: text selection, find (`Ctrl/⌘ F`), outline sidebar, working links, fit and zoom modes, `Ctrl`+wheel or pinch zoom, a reading progress bar, remembered position for each document, drag-and-drop for local files, and password-protected PDFs.
- **Opens PDFs automatically**: works for links ending in `.pdf` and for any response served as `application/pdf`. There is also a right-click **Open PDF in Lumen** option. Use **⋯ → Open in browser viewer** to fall back to the browser's own viewer.

| Key | Action |
| --- | --- |
| `T` / `Shift T` | Next / previous theme |
| `D` | Download themed PDF |
| `O` | Toggle contents |
| `←` `→` | Previous / next page |
| `Ctrl/⌘ +` `−` `0` | Zoom in / out / automatic |

## Build

```bash
npm install
npm run build        # creates dist/chrome, dist/firefox and dist/safari
npm run build:zip    # also creates store-ready zips in dist/
```

## Install

**Chrome, Edge, Brave, Opera**: open `chrome://extensions` (or `edge://extensions`), turn on *Developer mode*, choose *Load unpacked*, and select `dist/chrome`. To open local `file://` PDFs, turn on *Allow access to file URLs* in the extension's details.

**Firefox**: open `about:debugging#/runtime/this-firefox`, choose *Load Temporary Add-on*, and select `dist/firefox/manifest.json`. Then go to `about:addons` → Lumen PDF → *Permissions* and allow access to all websites.

**Safari (macOS / iOS)**: run the following on a Mac with Xcode installed:

```bash
xcrun safari-web-extension-converter dist/safari --app-name "Lumen PDF"
```

Build and run the generated Xcode project. Then enable the extension in Safari → Settings → Extensions, and allow it on all websites. Safari opens `.pdf` links automatically. For other PDFs, use the toolbar popup or the right-click menu.

## How it works

```
src/
  background.js      Sends PDF navigations to the viewer (redirect rule, Content-Type check, file:// URLs)
  shared/themes.js   Theme presets, settings storage, colour helpers
  viewer/
    viewer.js        PDF.js-based reader: lazy rendering, zoom, text layer, search, outline, UI
    recolor.js       Colour pipeline and image detection
    export.js        Themed PDF export (vector blend modes or raster)
  popup/             Toolbar popup: quick theme, auto-open toggle
```

Each page is rendered once with PDF.js. The viewer then reads the page's drawing instructions to find where each image was painted. The pixels are recoloured with a lookup table that matches the theme. The pixels inside image areas are copied back from the original render.

The colour formula maps exactly onto the PDF blend modes `Difference`, `Hue`, `Multiply` and `Screen`. Because of that, the *Crisp* export can rebuild the on-screen look inside the PDF itself, instead of saving pictures of the pages. Different PDF readers handle `Hue` blending slightly differently, so coloured text can vary a little. Choose *Exact* if you need a pixel-perfect copy.
