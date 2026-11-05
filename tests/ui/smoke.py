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
        for tab in ["summary","variance","forecast","alerts","history","realloc","data"]:
            await pg.click(f"nav button[data-tab={tab}]"); await pg.wait_for_timeout(250); await shot(f"t_{tab}")
        # interactions
        await pg.click("nav button[data-tab=overview]")
        # drill-down: company -> department -> project -> expense category -> forecast
        await pg.click("tr[data-drill='資訊科技部|']"); await pg.wait_for_timeout(200)
        assert "核心系統換版" in await pg.inner_text("#view table")
        await pg.click("tr[data-drill^='資訊科技部|1|核心系統換版']"); await pg.wait_for_timeout(200)
        crumbs = (await pg.inner_text(".crumbs")).replace("\n", " ")
        print("crumbs:", crumbs); assert "核心系統換版" in crumbs
        await shot("t_overview_project")
        await pg.click(".crumbs button[data-drill='資訊科技部|']"); await pg.wait_for_timeout(200)
        await pg.click(".seg[data-drill^='資訊科技部|1|核心系統換版']"); await pg.wait_for_timeout(200)
        await pg.click("button[data-fc-scope]"); await pg.wait_for_timeout(200)
        print("forecast scope:", await pg.input_value("select[data-ui='forecast.dept']"), await pg.input_value("select[data-ui='forecast.proj']"))
        assert await pg.input_value("select[data-ui='forecast.proj']") == "核心系統換版"
        await pg.select_option("select[data-ui='forecast.proj']", "*"); await pg.wait_for_timeout(150)
        await pg.fill("#whatif", "100"); await pg.dispatch_event("#whatif","input"); await pg.wait_for_timeout(100)
        print("whatif:", await pg.inner_text("#wf-val"), (await pg.inner_text("#wf-out"))[:120].replace("\n"," "))
        await pg.select_option("select[data-ui='forecast.cat']", index=1); await pg.wait_for_timeout(150)
        await pg.select_option("#asof", "8"); await pg.wait_for_timeout(300)
        print("as-of 8 kpis:", (await pg.inner_text(".kpis"))[:160].replace("\n"," "))
        await pg.click("nav button[data-tab=history]"); await pg.click("tr[data-hist-go='業務通路部|']"); await pg.wait_for_timeout(150)
        assert "經代通路拓展" in await pg.inner_text("#view table")
        await pg.click("nav button[data-tab=variance]"); await pg.select_option("select[data-ui='variance.level']", "series"); await pg.wait_for_timeout(150)
        await pg.select_option("select[data-ui='variance.dept']", "理賠部"); await pg.wait_for_timeout(150)
        await pg.select_option("select[data-ui='variance.proj']", "委外理賠調查"); await pg.wait_for_timeout(150)
        await pg.click("tr[data-var-sel='0']"); await pg.wait_for_timeout(150)
        print("variance project scope:", (await pg.inner_text("#view .grid2 .card:nth-child(2) h3")))
        await pg.click("nav button[data-tab=alerts]"); await pg.wait_for_timeout(200)
        assert await pg.locator("input[data-risk]").count() == 0 and "預警規則" in await pg.inner_text(".foot")
        print("alerts chips:", (await pg.inner_text(".chips")).replace("\n"," "))
        # upload test
        await pg.click("nav button[data-tab=data]")
        await pg.set_input_files("input[data-upload=budget]", str(ROOT / "docs/sample/budget.csv")); await pg.wait_for_timeout(500)
        await pg.set_input_files("input[data-upload=comm]", str(ROOT / "docs/sample/commitments.csv")); await pg.wait_for_timeout(500)
        print("after upload:", (await pg.inner_text("#source")), "|", (await pg.inner_text(".kpis"))[:200].replace("\n"," "))
        await pg.click("nav button[data-tab=overview]"); await pg.wait_for_timeout(200)
        # file without a project column: drill goes department -> categories
        import csv
        rows = list(csv.reader(open(ROOT / "docs/sample/budget.csv", encoding="utf-8-sig")))
        with open(f"{OUT}/noproj.csv", "w", encoding="utf-8") as f:
            csv.writer(f).writerows([r[:3] + r[4:] for r in rows])
        await pg.click("nav button[data-tab=data]"); await pg.set_input_files("input[data-upload=budget]", f"{OUT}/noproj.csv"); await pg.wait_for_timeout(500)
        await pg.click("nav button[data-tab=overview]"); await pg.click("tr[data-drill='資訊科技部|']"); await pg.wait_for_timeout(200)
        head = await pg.inner_text("#view thead")
        print("no-project drill header:", head.split("\t")[0]); assert "費用科目" in head
        # bad file
        open(f"{OUT}/bad.csv","w").write("a,b\n1,2\n")
        await pg.click("nav button[data-tab=data]"); await pg.set_input_files("input[data-upload=budget]", f"{OUT}/bad.csv"); await pg.wait_for_timeout(300)
        print("bad upload warn:", (await pg.inner_text(".warn")))
        await pg.set_viewport_size({"width":390,"height":800}); await pg.click("nav button[data-tab=overview]"); await pg.wait_for_timeout(200)
        print("mobile hscroll:", await pg.evaluate("document.documentElement.scrollWidth > window.innerWidth"))
        print("errors:", errs)
        errs = [e for e in errs if "Failed to load resource" not in e]  # web fonts are optional
        assert not errs, errs
        await b.close()
asyncio.run(main())
