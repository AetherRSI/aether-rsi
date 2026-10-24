"""render.py — the pages of a .pptx as images, for AetherRSI's `render` (spec §3.2). Python standard library only (the core's Python runs it).

    render.py <file> <out>                                         every page → <out>/p-N.png (width 1280) and <out>/deck.pdf
    render.py <file> <out> --page N --width W --base <full render>  that one page at width W → <out>/p-N.png (from <base>/deck.pdf)

The drawing is SoloGen v3's 📂 Files (apps/files/files.py `pages` / `hd_png`), itself v2's 📑 Slides (core/chat/render.py):
- LibreOffice turns the deck into a pdf, pdftoppm turns the pdf into pages. soffice gets a fonts.conf with the Mac's font folders:
  headless it sees only its own fonts, and Japanese text vanished
- pdftoppm uses one core, so the pages are split and drawn side by side (v2: 29 pages 5 s → about 1.5 s)
- the pdf is kept: one page drawn larger for a slideshow is then only pdftoppm (about 0.5 s)
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

WIDTH = 1280   # the normal page (v2's Slides and v3 alike)
FONTS_CONF = """<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
{dirs}
  <cachedir>{cache}</cachedir>
</fontconfig>
"""


def soffice():
    for c in (os.environ.get("AETHER_SOFFICE"), shutil.which("soffice"), "/Applications/LibreOffice.app/Contents/MacOS/soffice"):
        if c and Path(c).is_file():
            return c
    return None


def tool(name):
    for c in (shutil.which(name), f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}"):   # the core may run without the shell's PATH
        if c and Path(c).is_file():
            return c
    sys.exit(f"{name} is not installed (poppler: brew install poppler)")


def fonts_env(tmp: Path, so: str) -> dict:
    env = dict(os.environ)
    if sys.platform != "darwin":
        return env
    dirs = ["/System/Library/Fonts", "/Library/Fonts", str(Path.home() / "Library/Fonts"), str(Path(so).resolve().parents[1] / "Resources" / "fonts")]
    conf = tmp / "fonts.conf"
    conf.write_text(FONTS_CONF.format(dirs="\n".join(f"  <dir>{d}</dir>" for d in dirs if Path(d).is_dir()),
                                      cache=Path(os.environ.get("TMPDIR", "/tmp")) / "aether_pptx_fc"), encoding="utf-8")
    env["FONTCONFIG_FILE"] = str(conf)
    return env


def to_pdf(p: Path, out: Path) -> Path:
    so = soffice()
    if not so:
        sys.exit("LibreOffice is not installed (brew install --cask libreoffice)")
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        deck = tmp / f"deck{p.suffix.lower()}"   # a copy: a Japanese name or spaces must not confuse soffice
        shutil.copyfile(p, deck)
        r = subprocess.run([so, "--headless", "--norestore", f"-env:UserInstallation=file://{tmp}/lo", "--convert-to", "pdf", "--outdir", str(tmp), str(deck)],
                           capture_output=True, timeout=280, env=fonts_env(tmp, so))
        if not (tmp / "deck.pdf").exists():
            sys.exit(f"LibreOffice could not make a pdf: {r.stderr.decode(errors='replace')[-300:]}")
        shutil.move(str(tmp / "deck.pdf"), out / "deck.pdf")
    return out / "deck.pdf"


def npages(pdf: Path) -> int:
    r = subprocess.run([tool("pdfinfo"), str(pdf)], capture_output=True, text=True, timeout=60)
    for line in r.stdout.splitlines():
        if line.startswith("Pages:"):
            return int(line.split()[1])
    return 0


def full(p: Path, out: Path):
    pdf = p if p.suffix.lower() == ".pdf" else to_pdf(p, out)
    n = npages(pdf) or 1
    k = max(1, min(4, os.cpu_count() or 1, n))
    step = (n + k - 1) // k
    procs = [subprocess.Popen([tool("pdftoppm"), "-png", "-scale-to-x", str(WIDTH), "-scale-to-y", "-1", "-f", str(a), "-l", str(min(n, a + step - 1)), str(pdf), str(out / "p")],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for a in range(1, n + 1, step)]
    for pr in procs:
        pr.wait(timeout=max(60, n * 5))


def large(p: Path, out: Path, n: int, w: int, base: Path):
    pdf = p if p.suffix.lower() == ".pdf" else base / "deck.pdf"
    if not pdf.exists():
        pdf = to_pdf(p, out)
    subprocess.run([tool("pdftoppm"), "-png", "-singlefile", "-scale-to-x", str(w), "-scale-to-y", "-1", "-f", str(n), "-l", str(n), str(pdf), str(out / f"p-{n}")],
                   capture_output=True, timeout=120)
    (out / "deck.pdf").unlink(missing_ok=True)


def main():
    a = argparse.ArgumentParser()
    a.add_argument("file", type=Path)
    a.add_argument("out", type=Path)
    a.add_argument("--page", type=int, default=0)
    a.add_argument("--width", type=int, default=0)
    a.add_argument("--base", type=Path)
    x = a.parse_args()
    if x.page:
        large(x.file, x.out, x.page, x.width, x.base or x.out)
    else:
        full(x.file, x.out)


if __name__ == "__main__":
    main()
