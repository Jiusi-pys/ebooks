"""ADB lifecycle acceptance against the debug app's existing test library.

Never clears application data. Saves rotation state and restores it in finally.
Only reads the business database; compares every note before/after reinstall.
"""
import argparse
import hashlib
import json
import os
import re
import struct
from pathlib import Path
import sqlite3
import subprocess
import time
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument("--serial", default="127.0.0.1:16416")
parser.add_argument("--output", default=".tools/android-lifecycle")
parser.add_argument("--apk", required=True, help="APK built with -PshufangAcceptance=true")
parser.add_argument("--mumu-rotate",type=int,help="MuMu VM index; use its toolbar to rotate the app window")
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
output = (root / args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
adb = Path(os.environ["LOCALAPPDATA"]) / "Android/Sdk/platform-tools/adb.exe"
apk = Path(args.apk).resolve()
package = "org.shufang.android.acceptance"
tools = sorted((adb.parents[1] / "build-tools").glob("*/aapt2.exe"))
if not tools:
    raise RuntimeError("Android aapt2 is required to verify the isolated APK identity")
badging = subprocess.check_output([str(tools[-1]), "dump", "badging", str(apk)], text=True, encoding="utf-8")
if not re.search(r"package: name='" + re.escape(package) + r"'", badging):
    raise RuntimeError("Lifecycle acceptance requires the isolated acceptance APK")


def command(*parts, check=True):
    result = subprocess.run([str(adb), "-s", args.serial, *parts], capture_output=True, check=check)
    return result.stdout.decode("utf-8", errors="replace").strip()


def notes_snapshot(label):
    command("shell", "am", "force-stop", package)
    directory = output / label
    directory.mkdir(exist_ok=True)
    for suffix in ["", "-wal", "-shm"]:
        result = subprocess.run([str(adb), "-s", args.serial, "exec-out", "run-as", package, "cat", "files/workspaces/local/library.sqlite" + suffix], capture_output=True)
        if result.returncode == 0:
            (directory / ("library.sqlite" + suffix)).write_bytes(result.stdout)
        elif not suffix:
            raise RuntimeError("Local SQLite library is absent; run test-device.ps1 first")
    with sqlite3.connect(directory / "library.sqlite") as connection:
        rows = connection.execute("SELECT id,state_json FROM entities WHERE kind='notes' ORDER BY id").fetchall()
    assert rows, "The device must contain test notes before lifecycle acceptance"
    return {key: hashlib.sha256(value.encode()).hexdigest() for key, value in rows}


def capture(name):
    time.sleep(1)
    command("shell", "rm", "-f", "/sdcard/shufang-acceptance.xml")
    for attempt in range(3):
        try:
            command("shell", "uiautomator", "dump", "/sdcard/shufang-acceptance.xml")
            break
        except subprocess.CalledProcessError as error:
            # Some MuMu builds crash the uiautomator shutdown thread AFTER writing
            # the requested fresh hierarchy. Require that output before proceeding.
            if "UI hierchary dumped" in error.output.decode("utf-8",errors="replace"):
                report.setdefault("toolWarnings",[]).append(f"uiautomator exit {error.returncode} after successful hierarchy dump")
                break
            if attempt == 2:
                raise
            time.sleep(1)
    command("pull", "/sdcard/shufang-acceptance.xml", str(output / f"{name}.xml"))
    logical = current_display()
    displays = command("shell", "dumpsys", "display")
    mapping = dict(re.findall(r'DisplayInfo\{[^\n]+?displayId (\d+),[^\n]+?uniqueId "local:(\d+)"',displays))
    physical = mapping[str(logical)]
    screenshot = subprocess.check_output([str(adb), "-s", args.serial, "exec-out", "screencap", "-p", "-d",physical])
    assert screenshot.startswith(b"\x89PNG\r\n\x1a\n"), "Screenshot must be an actual PNG"
    (output / f"{name}.png").write_bytes(screenshot)
    nodes=ET.parse(output / f"{name}.xml").findall(".//node")
    assert any(node.get("package")==package for node in nodes), "App UI hierarchy must load"
    report.setdefault("screens",{})[name]={"display":logical,"size":struct.unpack(">II",screenshot[16:24])}


def current_display():
    activities=command("shell","dumpsys","activity","activities")
    for block in re.split(r"(?=Display #)",activities):
        if package in block:
            match=re.search(r"Display #(\d+)",block)
            if match:return int(match.group(1))
    raise RuntimeError("App has no visible display")


def launch():
    result = command("shell", "am", "start", "-W", "-n", package + "/org.shufang.android.MainActivity")
    assert "Status: ok" in result, result
    return result


before = notes_snapshot("before")
rotation = {key: command("shell", "settings", "get", "system", key) for key in ["accelerometer_rotation", "user_rotation"]}
report = {"noteCount": len(before), "apkSha256": hashlib.sha256(apk.read_bytes()).hexdigest(), "checks": []}
rotated_display=None;display_rotation=None
manager_rotated=False
try:
    report["coldLaunch"] = launch()
    capture("cold-start")
    command("shell", "input", "keyevent", "3")
    command("shell", "am", "force-stop", package)
    report["restartLaunch"] = launch()
    capture("process-restart")
    report["checks"].append("Home, process force-stop and cold restart")
    if args.mumu_rotate is not None:
        manager=Path(os.environ["ProgramFiles"])/"Netease/MuMu/nx_main/MuMuManager.exe"
        result=subprocess.check_output([str(manager),"control","-v",str(args.mumu_rotate),"tool","func","-n","rotate"])
        assert json.loads(result)["errcode"]==0
        manager_rotated=True
    else:
        rotated_display=current_display();display_rotation=command("shell","wm","user-rotation","-d",str(rotated_display))
        command("shell","wm","user-rotation","-d",str(rotated_display),"lock","0")
    capture("rotated")
    report["rotationVerified"]=report["screens"]["rotated"]["size"]!=report["screens"]["process-restart"]["size"]
    if report["rotationVerified"]:report["checks"].append("Portrait/landscape rotation retains visible native UI")
    else:report.setdefault("unverified",[]).append("Device ignored rotation request; screenshot size stayed unchanged")
    if manager_rotated:
        subprocess.run([str(manager),"control","-v",str(args.mumu_rotate),"tool","func","-n","rotate"],check=True,capture_output=True);manager_rotated=False
    if rotated_display is not None:
        command("shell","wm","user-rotation","-d",str(rotated_display),*display_rotation.split());rotated_display=None
    command("shell", "input", "keyevent", "4")
    launch()
    capture("system-back")
    report["checks"].append("System Back and reopen")
    command("shell", "am", "force-stop", package)
    installed = command("install", "-r", str(apk))
    assert "Success" in installed, installed
    launch()
    capture("cover-install")
    after = notes_snapshot("after")
    assert before == after, "Business note state changed across lifecycle/reinstall"
    report["checks"].append("Cover install preserves every existing test note")
finally:
    if manager_rotated:
        subprocess.run([str(manager),"control","-v",str(args.mumu_rotate),"tool","func","-n","rotate"],check=True,capture_output=True)
    if rotated_display is not None:
        command("shell","wm","user-rotation","-d",str(rotated_display),*display_rotation.split())
    for key, value in rotation.items():
        command("shell", "settings", "delete" if value == "null" else "put", "system", key, *([] if value == "null" else [value]))
    launch()
report["device"] = {key: command("shell", "getprop", key) for key in ["ro.build.version.release", "ro.build.version.sdk", "ro.product.cpu.abilist"]}
report["webview"] = command("shell", "dumpsys", "webviewupdate")
(output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
