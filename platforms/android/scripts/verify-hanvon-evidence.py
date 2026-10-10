"""Validate recorded geometry against the planned profiles; no Android mutations."""
import json
import re
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / "docs/evidence/android-ios/runtime"
profiles = {
    "clear7": (1264, 1680, EVIDENCE / "hanvon-mumu-final"),
    "n10pro2": (1860, 2480, EVIDENCE / "hanvon-mumu-n10-final"),
}
cases = [(o, f, 300) for o in ("portrait", "landscape") for f in ("1.0", "1.3", "2.0")]
cases += [("portrait", "1.0", dpi) for dpi in (240, 320)]
rows = []
for name, (short, long, directory) in profiles.items():
    for orientation, font, dpi in cases:
        case = directory / f"{name}-{orientation}-font{font}-dpi{dpi}"
        pixels = (short, long) if orientation == "portrait" else (long, short)
        metrics = json.loads((case / "metrics-reader.json").read_text(encoding="utf-8-sig"))
        assert (metrics["widthPixels"], metrics["heightPixels"]) == pixels, case
        assert metrics["densityDpi"] == dpi and abs(metrics["fontScale"] - float(font)) < .01, case
        assert abs(metrics["widthDp"] - pixels[0] * 160 / dpi) <= 1, case
        pdf = json.loads((case / "pdf-comparison.json").read_text(encoding="utf-8-sig"))
        assert pdf["viewCount"] == 2 and pdf["densityDpi"] == dpi, case
        assert abs(pdf["fontScale"] - float(font)) < .01, case
        assert pdf["widthDp"] == metrics["widthDp"] and pdf["heightDp"] == metrics["heightDp"], case
        assert pdf["first"]["page"] == pdf["second"]["page"], case
        assert abs(pdf["first"]["fraction"] - pdf["second"]["fraction"]) < .08, case
        for test in ("ReadingDesignTest", "PdfComparisonTouchTest"):
            log = (case / f"{test}.log").read_text(encoding="utf-8-sig")
            assert "OK (1 test)" in log and "FAILURES" not in log, case
        for image in ("redesign-shelf.png", "redesign-reader.png", "pdf-comparison.png"):
            content = (case / image).read_bytes()
            assert content[:8] == b"\x89PNG\r\n\x1a\n", case
            assert struct.unpack(">II", content[16:24]) == pixels, (case, image)
        rows.append({"profile": name, "orientation": orientation, "densityDpi": dpi,
                     "fontScale": float(font), "widthDp": metrics["widthDp"],
                     "heightDp": metrics["heightDp"], "pixels": pixels,
                     "passedTests": 2, "evidence": str(case.relative_to(ROOT))})
suites = []
for name, path in (("clear7", EVIDENCE / "hanvon-mumu-final/clear7-suite.log"),
                   ("n10pro2", EVIDENCE / "hanvon-mumu-n10-suite-final/n10pro2-suite.log")):
    log = path.read_text(encoding="utf-8-sig")
    assert "OK (37 tests)" in log and "FAILURES" not in log, path
    executed = sum(len(m) for m in re.findall(r"^org\.shufang\.android\.\w+:(\.+)\s*$", log, re.M))
    assert executed == 28, (path, executed)
    suites.append({"profile": name, "discovered": 37, "executedPassed": executed,
                   "conditionalSkipped": 37 - executed, "evidence": str(path.relative_to(ROOT))})
result = {"profiles": rows, "fullSuites": suites, "layoutConfigurations": len(rows),
          "layoutTestsPassed": sum(r["passedTests"] for r in rows),
          "totalExecutedPassed": sum(r["passedTests"] for r in rows) + sum(s["executedPassed"] for s in suites)}
(EVIDENCE / "hanvon-summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps({k: v for k, v in result.items() if not isinstance(v, list)}, ensure_ascii=False))
