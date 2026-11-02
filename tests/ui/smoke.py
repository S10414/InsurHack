"""UI smoke test: python tests/ui/smoke.py   (needs playwright + chromium). Drives every tab, uploads, what-if, mobile width."""
import asyncio, sys
from playwright.async_api import async_playwright
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
URL = (ROOT / "docs" / "index.html").as_uri()
import tempfile
OUT = tempfile.mkdtemp()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={"width":1280,"height":900})
        errs=[]; pg.on("pageerror", lambda e: errs.append("PAGEERR "+str(e))); pg.on("console", lambda m: errs.append("CONSOLE "+m.text) if m.type=="error" else None)
        await pg.goto(URL); await pg.wait_for_timeout(400)
        async def shot(name, full=True): await pg.screenshot(path=f"{OUT}/{name}.png", full_page=full)
        await shot("t_overview")
        for tab in ["variance","forecast","alerts","history","realloc","data"]:
            await pg.click(f"nav button[data-tab={tab}]"); await pg.wait_for_timeout(250); await shot(f"t_{tab}")
        # interactions
        await pg.click("nav button[data-tab=overview]")
        await pg.click("tr[data-dept-go='資訊科技部']"); await pg.wait_for_timeout(200)
        print("forecast dept select:", await pg.input_value("select[data-ui='forecast.dept']"))
        await pg.fill("#whatif", "100"); await pg.dispatch_event("#whatif","input"); await pg.wait_for_timeout(100)
        print("whatif:", await pg.inner_text("#wf-val"), (await pg.inner_text("#wf-out"))[:120].replace("\n"," "))
        await pg.select_option("select[data-ui='forecast.cat']", index=1); await pg.wait_for_timeout(150)
        await pg.select_option("#asof", "8"); await pg.wait_for_timeout(300)
        print("as-of 8 kpis:", (await pg.inner_text(".kpis"))[:160].replace("\n"," "))
        await pg.click("nav button[data-tab=alerts]"); await pg.fill("input[data-risk=minAmount]", "50"); await pg.dispatch_event("input[data-risk=minAmount]","change"); await pg.wait_for_timeout(200)
        print("alerts chips:", (await pg.inner_text(".chips")).replace("\n"," "))
        # upload test
        await pg.click("nav button[data-tab=data]")
        await pg.set_input_files("input[data-upload=budget]", str(ROOT / "docs/sample/budget.csv")); await pg.wait_for_timeout(500)
        await pg.set_input_files("input[data-upload=comm]", str(ROOT / "docs/sample/commitments.csv")); await pg.wait_for_timeout(500)
        print("after upload:", (await pg.inner_text("#source")), "|", (await pg.inner_text(".kpis"))[:200].replace("\n"," "))
        await pg.click("nav button[data-tab=overview]"); await pg.wait_for_timeout(200)
        # bad file
        open(f"{OUT}/bad.csv","w").write("a,b\n1,2\n")
        await pg.click("nav button[data-tab=data]"); await pg.set_input_files("input[data-upload=budget]", f"{OUT}/bad.csv"); await pg.wait_for_timeout(300)
        print("bad upload warn:", (await pg.inner_text(".warn")))
        await pg.set_viewport_size({"width":390,"height":800}); await pg.click("nav button[data-tab=overview]"); await pg.wait_for_timeout(200)
        print("mobile hscroll:", await pg.evaluate("document.documentElement.scrollWidth > window.innerWidth"))
        print("errors:", errs)
        assert not errs, errs
        await b.close()
asyncio.run(main())
