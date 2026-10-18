"""Render promo.html frame by frame (deterministic render(t)) and encode with ffmpeg.
   python3 render.py frames 3 9 20 ...   -> PNG keyframes in out/keys
   python3 render.py video                -> out/openzo-promo-silent.mp4"""
import subprocess, sys, pathlib
from playwright.sync_api import sync_playwright

here = pathlib.Path(__file__).resolve().parent
out = here / "out"; out.mkdir(exist_ok=True)
FPS = 30

with sync_playwright() as p:
    b = p.chromium.launch(args=["--disable-gpu-vsync", "--force-device-scale-factor=1"])
    page = b.new_page(viewport={"width": 1920, "height": 1080})
    page.goto((here / "promo.html").as_uri())
    page.wait_for_function("document.fonts.ready.then(() => true)")
    page.wait_for_timeout(1500)
    total = page.evaluate("window.PROMO.total")
    if sys.argv[1] == "frames":
        (out / "keys").mkdir(exist_ok=True)
        for t in sys.argv[2:]:
            page.evaluate(f"render({float(t)})")
            page.screenshot(path=str(out / "keys" / f"t{float(t):05.1f}.png"))
        print("keys done")
    else:
        n = int(total * FPS)
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "-",
                               "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(out / "openzo-promo-silent.mp4")], stdin=subprocess.PIPE)
        for i in range(n):
            page.evaluate(f"render({i / FPS})")
            ff.stdin.write(page.screenshot(type="jpeg", quality=93))
            if i % 300 == 0: print(f"frame {i}/{n}", flush=True)
        ff.stdin.close(); ff.wait()
        print("video done", ff.returncode)
    b.close()
