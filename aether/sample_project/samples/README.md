# samples/ — one file per preview feature

Open each file in 📂 Files and check what the right column says. The app sample is `../apps/hello-app/`. Every preview quotes on click; that is not repeated below.

| File | Preview | What to check |
|:--|:--|:--|
| `json-all.json` | 🧾 JSON | Every value type, empty `{}` `[]`, keys that need `["…"]` in the path, deep nesting, a 5,000-char string (the quote is cut at 4,000) |
| `json-large.json` | 🧾 JSON | Over 200,000 characters: opens folded below depth 2 |
| `json-broken.json` | 🧾 JSON | Not valid JSON: the error and the raw text |
| `text-code.py` `text-table.csv` `NOEXTENSION` | 📄 Plain text | `"match": ["*"]`: types no other preview takes, line by line (blank lines kept) |
| `text-crlf.txt` | 📄 Plain text | CRLF line endings and Japanese |
| `text-empty.txt` | 📄 Plain text | An empty file |
| `text-long.log` | 📄 Plain text | 20,500 lines: only the first 20,000 are shown, and the hint says so |
| `text-binary.bin` `text-latin1.txt` `text-image.png` | 📄 Plain text | Not text (a NUL byte, or not UTF-8): “is not text … Quote it” instead of a jumble |
