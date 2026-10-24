# samples/ — one file per preview feature

Open each file in 📂 Files and check what the right column says. Every preview quotes on click; that is not repeated below.

| File | Preview | What to check |
|:--|:--|:--|
| `markdown-all.md` | 📝 md | h1–h6, **bold** *italic* `code` links, `-` `*` `+` and numbered lists, quote, code fence, table, HTML shown as text, “Quote selection”. The last section lists what the small renderer does not cover |
| `same-preview.markdown` | 📝 md | The `.markdown` extension goes to the same preview |
| `json-all.json` | 🧾 JSON | Every value type, empty `{}` `[]`, keys that need `["…"]` in the path, deep nesting, a 5,000-char string (the quote is cut at 4,000) |
| `json-large.json` | 🧾 JSON | Over 200,000 characters: opens folded below depth 2 |
| `json-broken.json` | 🧾 JSON | Not valid JSON: the error and the raw text |
| `pptx-all.pptx` | 📊 PowerPoint | 7 slides: placeholders, bullet levels and runs, alignment and anchor, font sizes, fills, outline, rounded and ellipse, picture, table, slide background, group. Slide 7 has a chart, which is not covered (only its title shows) |
| `pptx-broken.pptx` | 📊 PowerPoint | Not a real deck: “Could not read …” |
| `text-code.py` `text-table.csv` `NOEXTENSION` | 📄 Plain text | `"match": ["*"]`: types no other preview takes, line by line (blank lines kept) |
| `text-crlf.txt` | 📄 Plain text | CRLF line endings and Japanese |
| `text-empty.txt` | 📄 Plain text | An empty file |
| `text-long.log` | 📄 Plain text | 20,500 lines: only the first 20,000 are shown, and the hint says so |
| `text-binary.bin` `text-latin1.txt` `text-image.png` | 📄 Plain text | Not text (a NUL byte, or not UTF-8): “is not text … Quote it” instead of a jumble |
| `hello-app/` | 🧩 app | A folder that is an app (`aether.json` kind app + `index.html` + `data.json` + `CLAUDE.md`): ▶ Open runs it in the panel, 🧩 quotes it with its rules |
